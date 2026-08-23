import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  archivePackageReceiptSchema,
  baselineManifestSchema,
  projectConfigSchema
} from "@hunter-harness/contracts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { HunterHarnessApiClient } from "../api/client.js";
import { sha256Bytes } from "../fs/hash.js";
import { readLocalCredentials, resolvePushAuth } from "../push/credentials.js";
import { uuidV7 } from "../project/uuid-v7.js";
import { runTransaction } from "../transaction/transaction.js";

export class ArchiveUploadError extends Error {
  readonly code: string;
  readonly exitCode: 3 | 4 | 6 | 8;

  constructor(message: string, code: string, exitCode: 3 | 4 | 6 | 8) {
    super(message);
    this.name = "ArchiveUploadError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface UploadArchivePackageOptions {
  projectRoot: string;
  archivePath: string;
  changeKey: string;
  serverUrl?: string;
  tokenEnv?: string;
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function bindResolvedProject(
  root: string,
  project: ReturnType<typeof projectConfigSchema.parse>,
  projectId: string
): Promise<void> {
  const nextProject = projectConfigSchema.parse({
    ...project,
    project: { ...project.project, project_id: projectId }
  });
  const operations: Array<{
    operation: "modify";
    path: string;
    content: string;
  }> = [{
    operation: "modify",
    path: ".harness/project.yaml",
    content: stringifyYaml(nextProject, { sortMapEntries: true })
  }];
  try {
    const baselinePath = join(root, ".harness", "state", "baseline", "manifest.json");
    const baseline = baselineManifestSchema.parse(JSON.parse(await readFile(baselinePath, "utf8")));
    operations.push({
      operation: "modify",
      path: ".harness/state/baseline/manifest.json",
      content: JSON.stringify({ ...baseline, project_id: projectId }, null, 2) + "\n"
    });
  } catch {
    // Archive upload can still bind project.yaml when legacy installs have no baseline.
  }
  await runTransaction(root, operations);
}

interface ArchiveUploadContext {
  archivePath: string;
  client: HunterHarnessApiClient;
  projectId: string;
}

async function resolveArchiveUploadContext(
  options: UploadArchivePackageOptions
): Promise<ArchiveUploadContext> {
  const root = resolve(options.projectRoot);
  const archivePath = resolve(root, options.archivePath);
  if (!inside(root, archivePath)) {
    throw new ArchiveUploadError(
      "archive package must be inside the project root",
      "ARCHIVE_PATH_OUTSIDE_PROJECT",
      6
    );
  }
  const metadata = await lstat(archivePath).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ArchiveUploadError(
      "archive package is missing or unsafe",
      "ARCHIVE_PACKAGE_NOT_FOUND",
      6
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(options.changeKey)) {
    throw new ArchiveUploadError("change key is invalid", "ARCHIVE_CHANGE_KEY_INVALID", 6);
  }

  let project: ReturnType<typeof projectConfigSchema.parse>;
  try {
    project = projectConfigSchema.parse(parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ));
  } catch {
    throw new ArchiveUploadError(
      "project configuration is missing or invalid",
      "PROJECT_CONFIG_INVALID",
      3
    );
  }
  const localCredentials = await readLocalCredentials(root);
  const auth = resolvePushAuth({
    ...(options.serverUrl === undefined ? {} : { serverUrlFlag: options.serverUrl }),
    ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
    env: options.env,
    local: localCredentials,
    projectUrl: project.server.url,
    projectTokenEnv: project.server.token_env
  });
  if ("code" in auth) {
    throw new ArchiveUploadError(
      auth.code === "SERVER_URL_REQUIRED"
        ? "server URL is required for archive upload"
        : "API token is required for archive upload",
      auth.code,
      auth.code === "SERVER_URL_REQUIRED" ? 3 : 8
    );
  }
  if (localCredentials?.project_id !== undefined &&
      project.project.project_id !== null &&
      localCredentials.project_id !== project.project.project_id) {
    throw new ArchiveUploadError(
      "credentials project_id conflicts with project.yaml",
      "PROJECT_BINDING_MISMATCH",
      4
    );
  }

  const client = new HunterHarnessApiClient({
    serverUrl: auth.serverUrl,
    token: auth.token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  let projectId = localCredentials?.project_id ?? project.project.project_id;
  if (projectId === null || projectId === undefined) {
    const resolved = await client.resolveProject({
      schema_version: 1,
      local_project_key: project.project.local_project_key,
      display_name: project.project.name,
      requested_project_id: null,
      client_id: "cli_archive"
    }, uuidV7(), uuidV7());
    projectId = resolved.project_id;
    await bindResolvedProject(root, project, projectId);
  }
  return { archivePath, client, projectId };
}

export async function uploadArchivePackage(options: UploadArchivePackageOptions) {
  const { archivePath, client, projectId } = await resolveArchiveUploadContext(options);

  const archive = new Uint8Array(await readFile(archivePath));
  const expectedHash = sha256Bytes(archive);
  const uploadRequestId = uuidV7();
  const rawResult = await client.uploadChangeArchivePackage({
    projectId,
    changeKey: options.changeKey,
    archive,
    requestId: uploadRequestId,
    idempotencyKey: uuidV7()
  });
  const parsed = archivePackageReceiptSchema.safeParse(rawResult);
  if (!parsed.success) {
    throw new ArchiveUploadError(
      "server returned an invalid archive receipt",
      "ARCHIVE_RECEIPT_INVALID",
      4
    );
  }
  const result = parsed.data;
  if (result.project_id !== projectId ||
      result.change_key !== options.changeKey ||
      result.request_id !== uploadRequestId) {
    throw new ArchiveUploadError(
      "server receipt does not belong to this archive request",
      "ARCHIVE_RECEIPT_SCOPE_MISMATCH",
      4
    );
  }
  if (result.package_sha256 !== expectedHash) {
    throw new ArchiveUploadError(
      "server receipt does not match the uploaded ZIP",
      "ARCHIVE_RECEIPT_HASH_MISMATCH",
      4
    );
  }
  return result;
}

// 只读预检：把 ZIP 发给服务端的 validate 端点，跑与正式上传完全相同的包校验
// （含 summary CLI schema 2.2/3 与字段级 issues），但不产生任何服务端状态。
export async function validateArchivePackage(options: UploadArchivePackageOptions) {
  const { archivePath, client, projectId } = await resolveArchiveUploadContext(options);
  const archive = new Uint8Array(await readFile(archivePath));
  return client.validateChangeArchivePackage({
    projectId,
    changeKey: options.changeKey,
    archive,
    requestId: uuidV7()
  });
}
