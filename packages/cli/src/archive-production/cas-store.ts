import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

// core barrel 有意收窄类型导出；LocalArchiveZipRef 形状在 archive-outbox/types.ts:13-17，
// 此处本地结构化声明，调用 core API 时结构匹配。
export interface LocalArchiveZipRef {
  readonly ref_id: string;
  readonly package_sha256: `sha256:${string}`;
  readonly size_bytes: number;
}

/**
 * Archive ZIP 内容寻址存储（CAS）与受信 resolver（06B-3 T0-2 冻结语义）。
 *
 * - 布局：`.harness/state/local/archive-cas/<package_sha256>.zip` + 同前缀 `.binding.json`
 * - ref_id 派生身份：`archive_cas:<sha256.slice(7,39)>`，不含路径，调用方无法注入路径
 * - resolver 只认字节复核（hash + size + binding project 列表），拒绝调用方给路径
 */

const SHA = /^sha256:[a-f0-9]{64}$/u;
const REF_ID = /^archive_cas:[a-f0-9]{32}$/u;

export interface ArchiveCasBinding {
  readonly schema_version: 1;
  readonly package_sha256: `sha256:${string}`;
  readonly size_bytes: number;
  readonly project_ids: readonly string[];
  readonly first_seen_at: string;
  readonly record_hash: `sha256:${string}`;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const sha256Tagged = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;

const casRoot = (projectRoot: string): string => join(projectRoot, ".harness", "state", "local", "archive-cas");

const zipPath = (projectRoot: string, packageSha256: string): string =>
  join(casRoot(projectRoot), `${packageSha256.slice(7)}.zip`);

const bindingPath = (projectRoot: string, packageSha256: string): string =>
  join(casRoot(projectRoot), `${packageSha256.slice(7)}.binding.json`);

async function writeAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, path);
}

function validBinding(value: unknown): value is ArchiveCasBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!["schema_version", "package_sha256", "size_bytes", "project_ids", "first_seen_at", "record_hash"]
    .every((key) => keys.includes(key))) return false;
  if (record.schema_version !== 1 || typeof record.package_sha256 !== "string" ||
      !SHA.test(record.package_sha256) || !Number.isSafeInteger(record.size_bytes) ||
      (record.size_bytes as number) < 0 || !Array.isArray(record.project_ids) ||
      (record.project_ids as unknown[]).some((item) => typeof item !== "string") ||
      typeof record.first_seen_at !== "string" || typeof record.record_hash !== "string" ||
      !SHA.test(record.record_hash)) return false;
  const body = { ...record };
  delete body.record_hash;
  return sha256Tagged(body) === record.record_hash;
}

function sealBinding(body: Omit<ArchiveCasBinding, "record_hash">): ArchiveCasBinding {
  return Object.freeze({ ...body, record_hash: sha256Tagged(body) });
}

/** 把包字节写入 CAS（已存在同 hash 则合并 project 列表后幂等返回）。 */
export async function putArchiveCas(
  projectRoot: string,
  bytes: Uint8Array,
  identity: { readonly project_id: string; readonly change_identity?: string }
): Promise<LocalArchiveZipRef> {
  if (identity.project_id.trim() === "") throw new Error("ARCHIVE_CAS_IDENTITY_INVALID");
  const hex = sha256Hex(bytes);
  const packageSha256 = `sha256:${hex}` as const;
  await writeAtomic(zipPath(projectRoot, packageSha256), bytes);
  let binding: ArchiveCasBinding;
  try {
    const existing = JSON.parse(await fs.readFile(bindingPath(projectRoot, packageSha256), "utf8")) as unknown;
    if (!validBinding(existing) || existing.package_sha256 !== packageSha256 ||
        existing.size_bytes !== bytes.byteLength) {
      throw new Error("ARCHIVE_CAS_BINDING_CORRUPT");
    }
    binding = existing.project_ids.includes(identity.project_id)
      ? existing
      : (() => { const rest = { schema_version: existing.schema_version, package_sha256: existing.package_sha256,
          size_bytes: existing.size_bytes, project_ids: [...existing.project_ids, identity.project_id].sort(),
          first_seen_at: existing.first_seen_at };
          return sealBinding(rest); })();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    binding = sealBinding({
      schema_version: 1,
      package_sha256: packageSha256,
      size_bytes: bytes.byteLength,
      project_ids: [identity.project_id],
      first_seen_at: new Date().toISOString()
    });
  }
  await writeAtomic(bindingPath(projectRoot, packageSha256), JSON.stringify(binding, null, 2));
  return Object.freeze({
    ref_id: `archive_cas:${hex.slice(0, 32)}`,
    package_sha256: packageSha256,
    size_bytes: bytes.byteLength
  });
}

export interface LocalArchiveZipResolverPort {
  readonly resolve: (ref: LocalArchiveZipRef, projectId: string) => Promise<Uint8Array>;
}

/** 受信 resolver：只认 CAS 内字节复核，拒绝调用方路径/伪造 ref/跨项目读取。 */
export function createLocalArchiveZipResolver(options: { readonly projectRoot: string }): LocalArchiveZipResolverPort {
  const root = options.projectRoot;
  return Object.freeze({
    async resolve(ref: LocalArchiveZipRef, projectId: string): Promise<Uint8Array> {
      if (ref === null || typeof ref !== "object") throw new Error("ARCHIVE_ZIP_REF_UNTRUSTED");
      if (typeof ref.ref_id !== "string" || !REF_ID.test(ref.ref_id) ||
          typeof ref.package_sha256 !== "string" || !SHA.test(ref.package_sha256) ||
          !Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0 ||
          ref.ref_id !== `archive_cas:${ref.package_sha256.slice(7, 39)}`) {
        throw new Error("ARCHIVE_ZIP_REF_UNTRUSTED");
      }
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(zipPath(root, ref.package_sha256));
      } catch {
        throw new Error("ARCHIVE_ZIP_REF_UNTRUSTED");
      }
      if (bytes.byteLength !== ref.size_bytes || sha256Hex(bytes) !== ref.package_sha256.slice(7)) {
        throw new Error("ARCHIVE_ZIP_REF_UNTRUSTED");
      }
      let binding: unknown;
      try {
        binding = JSON.parse(await fs.readFile(bindingPath(root, ref.package_sha256), "utf8"));
      } catch {
        throw new Error("ARCHIVE_ZIP_REF_UNTRUSTED");
      }
      if (!validBinding(binding) || binding.package_sha256 !== ref.package_sha256 ||
          binding.size_bytes !== ref.size_bytes || !binding.project_ids.includes(projectId)) {
        throw new Error("ARCHIVE_ZIP_REF_UNTRUSTED");
      }
      return new Uint8Array(bytes);
    }
  });
}
