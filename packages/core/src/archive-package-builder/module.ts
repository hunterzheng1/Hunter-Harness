import { createHash } from "node:crypto";

import {
  classifyContentPath,
  knowledgeCandidateSchema,
  projectContentCandidateSchema
} from "@hunter-harness/contracts";

import { normalizeArchiveRecord, type LocalArchiveReceipt } from "../archive-engine/index.js";
import { ArchivePackageBuilderError } from "./errors.js";
import {
  compareCodepoint,
  deepFreeze,
  equalBytes,
  sha256Bytes,
  stableHash,
  stableJson
} from "./stable.js";
import type {
  ArchivePackageCompletionEvidence,
  ArchivePackageBuildResult,
  ArchivePackageBuilder,
  ArchivePackageEntry,
  ArchivePackagePort,
  ArchivePackageReasonCode,
  ArchivePackageReceipt,
  CoreV2Projection,
  DeterministicZipConfig,
  PackageVerification,
  PublishedArchiveInventory
} from "./types.js";
import {
  canonicalPackagePath,
  exactOwnDataKeys,
  plainOwnDataRecord,
  strictRfc3339
} from "./validation.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const sha = /^sha256:[a-f0-9]{64}$/u;
const operationId = /^archive_operation:[a-f0-9]{64}$/u;
const exactPaths = new Set([
  "summary/change-summary.json",
  "attestations/verification.json",
  "candidates/knowledge.json",
  "candidates/project-content.json",
  "archive-meta.json",
  "archive-meta.md",
  "change-context.json"
]);
const requiredCandidatePaths = ["candidates/knowledge.json", "candidates/project-content.json"] as const;
const manifestPath = "archive-manifest.json";
const zipConfig: DeterministicZipConfig = Object.freeze({
  entry_mtime: "1980-01-01T00:00:00.000Z",
  file_mode: 0o100644,
  compression: "deflate",
  compression_level: 9
});

function fail(code: ArchivePackageReasonCode, message: string): never {
  throw new ArchivePackageBuilderError(code, message);
}

function coreV2Path(path: string): boolean {
  return exactPaths.has(path) || /^(?:spec|plans)\/[^/]+(?:\/[^/]+)*\.md$/u.test(path);
}

function classifierAllows(path: string): boolean {
  const result = classifyContentPath({ schema_version: 1, path, source_kind: "branch_file" });
  return "content_kind" in result;
}

function validateReceiptAndInventory(receipt: LocalArchiveReceipt, inventory: PublishedArchiveInventory): void {
  const normalized = normalizeArchiveRecord(receipt);
  if (!normalized.ok || normalized.source_schema_version !== 1 || normalized.readiness !== "ready" ||
      inventory.schema_version !== 1 || !operationId.test(inventory.operation_id) ||
      inventory.operation_id !== receipt.operation_id || inventory.change_identity !== receipt.change_identity ||
      inventory.closure_disposition !== receipt.closure_disposition ||
      inventory.archive_intent !== receipt.archive_intent ||
      inventory.source_snapshot_hash !== receipt.source_snapshot_hash ||
      inventory.archive_schema_version !== receipt.archive_schema_version ||
      inventory.archive_path !== receipt.archive_path ||
      inventory.archive_manifest_hash !== receipt.archive_manifest_hash ||
      inventory.completed_at !== receipt.completed_at || !Array.isArray(inventory.files)) {
    fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "本地归档收据与发布清单不一致");
  }
}

function validateProjection(projection: CoreV2Projection): void {
  if (projection.schema_version !== 2 || !/^prj_[a-z0-9._:-]+$/u.test(projection.project_id) ||
      !/^pv_[a-z0-9._:-]+$/u.test(projection.project_version) ||
      !/^arc_[a-z0-9._:-]+$/u.test(projection.archive_id) || !Array.isArray(projection.files)) {
    fail("ARCHIVE_PACKAGE_INPUT_INVALID", "core-v2 projection 身份无效");
  }
}

function validateInventoryPaths(inventory: PublishedArchiveInventory): void {
  const exact = new Set<string>();
  const folded = new Map<string, string>();
  for (const file of inventory.files) {
    if (!canonicalPackagePath(file.path) || exact.has(file.path) ||
        !sha.test(file.content_hash) || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 ||
        typeof file.read_content !== "function") {
      fail("ARCHIVE_PACKAGE_PATH_INVALID", `发布清单路径或声明无效：${String(file.path)}`);
    }
    const key = file.path.normalize("NFC").toLowerCase();
    const previous = folded.get(key);
    if (previous !== undefined) fail("ARCHIVE_PACKAGE_PATH_INVALID", `路径发生跨平台冲突：${previous} / ${file.path}`);
    exact.add(file.path);
    folded.set(key, file.path);
  }
  if (!exact.has(manifestPath)) fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "发布清单缺少源 manifest");
}


function validateProjectionPaths(projection: CoreV2Projection,
  inventory: PublishedArchiveInventory): void {
  const folded = new Map(inventory.files.map((file) => [file.path.normalize("NFC").toLowerCase(), file.path]));
  for (const file of projection.files) {
    if (!canonicalPackagePath(file.path) ||
        !sha.test(file.content_hash) || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 ||
        typeof file.read_content !== "function") {
      fail("ARCHIVE_PACKAGE_PATH_INVALID", `projection 路径或声明无效：${String(file.path)}`);
    }
    const key = file.path.normalize("NFC").toLowerCase();
    const previous = folded.get(key);
    if (previous !== undefined) fail("ARCHIVE_PACKAGE_PATH_INVALID", `路径发生跨平台冲突：${previous} / ${file.path}`);
    folded.set(key, file.path);
  }
}

function parseJson(bytes: Uint8Array, code: ArchivePackageReasonCode): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    fail(code, "JSON 内容无效");
  }
}

function validateSourceManifest(bytes: Uint8Array, receipt: LocalArchiveReceipt,
  inventory: PublishedArchiveInventory): void {
  if (sha256Bytes(bytes) !== receipt.archive_manifest_hash) {
    fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "源 manifest 哈希与本地收据不匹配");
  }
  const raw = parseJson(bytes, "ARCHIVE_PACKAGE_SOURCE_INVALID");
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "源 manifest 结构无效");
  }
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).sort(compareCodepoint).join("\0") !==
      ["change_identity", "files", "operation_id", "schema_version", "source_snapshot_hash"]
        .sort(compareCodepoint).join("\0") || record.schema_version !== 1 || record.operation_id !== receipt.operation_id ||
      record.change_identity !== receipt.change_identity ||
      record.source_snapshot_hash !== receipt.source_snapshot_hash || !Array.isArray(record.files)) {
    fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "源 manifest 身份不匹配");
  }
  if (!equalBytes(bytes, encoder.encode(`${stableJson(record)}\n`))) {
    fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "源 manifest 不是 canonical payload");
  }
  const declared = record.files as unknown[];
  const actual = inventory.files.filter((file) => file.path !== manifestPath)
    .map(({ path, content_hash, size_bytes }) => ({ path, content_hash, size_bytes }))
    .sort((left, right) => compareCodepoint(left.path, right.path));
  if (declared.length === 0 || stableHash(declared) !== stableHash(actual) || declared.some((item) =>
    item === null || typeof item !== "object" || Array.isArray(item) ||
    Object.keys(item).sort(compareCodepoint).join("\0") !==
      ["content_hash", "path", "size_bytes"].sort(compareCodepoint).join("\0"))) {
    fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "源 manifest 与本地 inventory 不闭合");
  }
}

function validateCandidates(entries: readonly ArchivePackageEntry[], receipt: LocalArchiveReceipt,
  projection: CoreV2Projection): void {
  const paths = new Set(entries.map((entry) => entry.path));
  const bound = (reference: string): boolean => {
    const path = reference.split("#", 1)[0] ?? reference;
    return paths.has(path) && !path.startsWith("candidates/");
  };
  for (const path of requiredCandidatePaths) {
    const entry = entries.find((item) => item.path === path);
    if (entry === undefined) fail("ARCHIVE_PACKAGE_CANDIDATE_INVALID", `缺少候选文件：${path}`);
    const parsed = parseJson(entry.content, "ARCHIVE_PACKAGE_CANDIDATE_INVALID");
    if (!Array.isArray(parsed)) {
      fail("ARCHIVE_PACKAGE_CANDIDATE_INVALID", `候选文件 Schema 无效：${path}`);
    }
    if (path === "candidates/knowledge.json") {
      const candidates = parsed.map((item) => knowledgeCandidateSchema.safeParse(item));
      if (candidates.some((result) => !result.success) || candidates.some((result) => result.success &&
          (result.data.source_change_key !== receipt.change_identity ||
           result.data.provenance.source_ref !== projection.archive_id ||
           result.data.source_refs.some((reference) => !bound(reference))))) {
        fail("ARCHIVE_PACKAGE_CANDIDATE_INVALID", "知识候选未绑定当前归档来源");
      }
    } else {
      const candidates = parsed.map((item) => projectContentCandidateSchema.safeParse(item));
      if (candidates.some((result) => !result.success) || candidates.some((result) => result.success &&
          (result.data.source_change_key !== receipt.change_identity ||
           result.data.provenance.source_ref !== projection.archive_id ||
           result.data.evidence_refs.some((reference) => !bound(reference))))) {
        fail("ARCHIVE_PACKAGE_CANDIDATE_INVALID", "项目内容候选未绑定当前归档来源");
      }
    }
  }
}

async function readDeclaredContent(
  read: PublishedArchiveInventory["files"][number]["read_content"]
): Promise<{ content: Uint8Array; content_hash: `sha256:${string}`; size_bytes: number }> {
  const source = read();
  if (source instanceof Promise) {
    const content = await source;
    return { content: content.slice(), content_hash: sha256Bytes(content), size_bytes: content.byteLength };
  }
  const chunks: Uint8Array[] = [];
  const hasher = createHash("sha256");
  let size = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "流式来源包含非字节 chunk");
    const copy = chunk.slice();
    chunks.push(copy);
    hasher.update(copy);
    size += copy.byteLength;
    if (!Number.isSafeInteger(size)) fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "流式来源大小溢出");
  }
  const content = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    content,
    content_hash: `sha256:${hasher.digest("hex")}`,
    size_bytes: size
  };
}

function manifestBytes(receipt: LocalArchiveReceipt, projection: CoreV2Projection,
  sourceReceiptHash: `sha256:${string}`, localInventoryHash: `sha256:${string}`,
  projectionHash: `sha256:${string}`, sourceReadCount: number, sourceBytesRead: number,
  packageCompletedAt: string,
  entries: readonly ArchivePackageEntry[]): Uint8Array {
  const manifest = {
    schema_version: 2,
    project_id: projection.project_id,
    change_key: receipt.change_identity,
    archive_id: projection.archive_id,
    project_version: projection.project_version,
    package_schema_version: 2,
    archive_schema_version: receipt.archive_schema_version,
    source_receipt: receipt,
    source_receipt_hash: sourceReceiptHash,
    local_inventory_hash: localInventoryHash,
    projection_hash: projectionHash,
    source_read_count: sourceReadCount,
    source_bytes_read: sourceBytesRead,
    package_completed_at: packageCompletedAt,
    file_count: entries.length,
    files: [...entries].sort((left, right) => compareCodepoint(left.path, right.path)).map((entry) => ({
      path: entry.path,
      content_sha256: entry.content_hash,
      size_bytes: entry.size_bytes
    }))
  };
  return encoder.encode(`${stableJson(manifest)}\n`);
}

function receiptPayload(receipt: Omit<ArchivePackageReceipt, "receipt_hash">): unknown {
  return receipt;
}

function sameConfig(value: DeterministicZipConfig): boolean {
  return stableHash(value) === stableHash(zipConfig);
}

function cloneBuildResult(value: ArchivePackageBuildResult): ArchivePackageBuildResult {
  return {
    package_bytes: value.package_bytes.slice(),
    manifest_bytes: value.manifest_bytes.slice(),
    receipt: value.receipt
  };
}

function validCompletionEvidence(
  value: unknown,
  packageOperationId: ArchivePackageCompletionEvidence["package_operation_id"],
  operationId: LocalArchiveReceipt["operation_id"],
  immutableIdentity: `sha256:${string}`
): value is ArchivePackageCompletionEvidence {
  try {
    if (!plainOwnDataRecord(value)) return false;
    const record = value as Record<string, unknown>;
    return exactOwnDataKeys(record, [
      "completed_at", "immutable_identity", "operation_id", "package_operation_id",
      "receipt_hash", "schema_version"
    ]) && record.schema_version === 1 &&
      record.package_operation_id === packageOperationId && record.operation_id === operationId &&
      record.immutable_identity === immutableIdentity && typeof record.receipt_hash === "string" &&
      sha.test(record.receipt_hash) && strictRfc3339(record.completed_at);
  } catch {
    return false;
  }
}

export function createArchivePackageBuilder(input: {
  readonly port: ArchivePackagePort;
  readonly clock?: (() => Date) | undefined;
}): ArchivePackageBuilder {
  const port = input.port;
  const clock = input.clock ?? (() => new Date());
  const completed = new Map<string, ArchivePackageBuildResult>();
  const operationIdentities = new Map<string, string>();

  async function buildPackage(localReceipt: LocalArchiveReceipt, inventory: PublishedArchiveInventory,
    projection: CoreV2Projection, packageSchemaVersion: 2): Promise<ArchivePackageBuildResult> {
    if (packageSchemaVersion !== 2) fail("ARCHIVE_PACKAGE_INPUT_INVALID", "仅允许写入 core-v2 包");
    validateReceiptAndInventory(localReceipt, inventory);
    validateInventoryPaths(inventory);
    validateProjection(projection);
    validateProjectionPaths(projection, inventory);
    const sourceReceiptHash = stableHash(localReceipt);
    const inventoryHash = stableHash(inventory.files.map(({ path, content_hash, size_bytes }) =>
      ({ path, content_hash, size_bytes })).sort((left, right) => compareCodepoint(left.path, right.path)));
    const immutableIdentity = stableHash({
      source_receipt_hash: sourceReceiptHash,
      local_inventory_hash: inventoryHash,
      projection_hash: stableHash({
        schema_version: projection.schema_version,
        project_id: projection.project_id,
        project_version: projection.project_version,
        archive_id: projection.archive_id,
        files: projection.files.map(({ path, content_hash, size_bytes }) => ({ path, content_hash, size_bytes }))
          .sort((left, right) => compareCodepoint(left.path, right.path))
      }),
      package_schema_version: packageSchemaVersion
    });
    const operationKey = `${localReceipt.operation_id}:${packageSchemaVersion}`;
    const priorIdentity = operationIdentities.get(operationKey);
    if (priorIdentity !== undefined && priorIdentity !== immutableIdentity) {
      fail("ARCHIVE_PACKAGE_IMMUTABLE_CONFLICT", "相同本地归档操作的完整输入发生漂移");
    }
    const packageOperationId = `archive_package_operation:${immutableIdentity.slice("sha256:".length)}` as const;
    const cached = completed.get(packageOperationId);
    if (cached !== undefined) {
      if (cached.receipt.project_id !== projection.project_id ||
          cached.receipt.project_version !== projection.project_version ||
          cached.receipt.archive_id !== projection.archive_id) {
        fail("ARCHIVE_PACKAGE_IMMUTABLE_CONFLICT", "相同包身份不能重新绑定项目或归档元数据");
      }
      return cloneBuildResult(cached);
    }
    const priorCompletion = await port.readCompletion(packageOperationId);
    if (priorCompletion !== undefined && !validCompletionEvidence(priorCompletion,
      packageOperationId, localReceipt.operation_id, immutableIdentity)) {
      fail("ARCHIVE_PACKAGE_PORT_INVALID", "PackagePort 返回无效 completion evidence");
    }
    let completedAt: string;
    if (priorCompletion === undefined) {
      const completedDate = clock();
      if (!(completedDate instanceof Date) || !Number.isFinite(completedDate.getTime())) {
        fail("ARCHIVE_PACKAGE_INPUT_INVALID", "PackageBuilder 时钟无效");
      }
      completedAt = completedDate.toISOString();
    } else {
      completedAt = priorCompletion.completed_at;
    }

    let sourceReadCount = 0;
    let sourceBytesRead = 0;
    let sourceManifest: Uint8Array | undefined;
    const entries: ArchivePackageEntry[] = [];
    for (const declared of [...inventory.files].sort((left, right) => compareCodepoint(left.path, right.path))) {
      const read = await readDeclaredContent(declared.read_content.bind(declared));
      const content = read.content;
      sourceReadCount += 1;
      sourceBytesRead += read.size_bytes;
      if (read.size_bytes !== declared.size_bytes ||
          (declared.path !== manifestPath && read.content_hash !== declared.content_hash)) {
        fail("ARCHIVE_PACKAGE_SOURCE_INVALID", `发布文件与声明不匹配：${declared.path}`);
      }
      if (declared.path === manifestPath) {
        sourceManifest = content;
      } else if (coreV2Path(declared.path) && classifierAllows(declared.path)) {
        entries.push({
          path: declared.path,
          content: content.slice(),
          content_hash: sha256Bytes(content),
          size_bytes: content.byteLength
        });
      }
    }
    if (sourceManifest === undefined) fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "源 manifest 无法读取");
    validateSourceManifest(sourceManifest, localReceipt, inventory);
    for (const declared of [...projection.files].sort((left, right) => compareCodepoint(left.path, right.path))) {
      if (!coreV2Path(declared.path) || !classifierAllows(declared.path)) continue;
      const read = await readDeclaredContent(declared.read_content.bind(declared));
      sourceReadCount += 1;
      sourceBytesRead += read.size_bytes;
      if (read.size_bytes !== declared.size_bytes || read.content_hash !== declared.content_hash) {
        fail("ARCHIVE_PACKAGE_SOURCE_INVALID", `projection 文件与声明不匹配：${declared.path}`);
      }
      entries.push({ path: declared.path, content: read.content.slice(),
        content_hash: read.content_hash, size_bytes: read.size_bytes });
    }
    const projectionHash = stableHash({ schema_version: projection.schema_version,
      project_id: projection.project_id, project_version: projection.project_version,
      archive_id: projection.archive_id, files: projection.files.map(({ path, content_hash, size_bytes }) =>
        ({ path, content_hash, size_bytes })).sort((left, right) => compareCodepoint(left.path, right.path)) });
    validateCandidates(entries, localReceipt, projection);
    const manifest = manifestBytes(localReceipt, projection, sourceReceiptHash, inventoryHash,
      projectionHash, sourceReadCount, sourceBytesRead, completedAt, entries);
    const packageEntries = [...entries, {
      path: manifestPath,
      content: manifest,
      content_hash: sha256Bytes(manifest),
      size_bytes: manifest.byteLength
    }].sort((left, right) => compareCodepoint(left.path, right.path));
    const packageBytes = await port.build(packageEntries, zipConfig);
    const inspected = await port.inspect(packageBytes);
    if (!sameConfig(inspected.zip_config) || inspected.entries.length !== packageEntries.length ||
        inspected.entries.some((entry, index) => {
          const expected = packageEntries[index];
          return expected === undefined || entry.path !== expected.path || entry.content_hash !== expected.content_hash ||
            entry.size_bytes !== expected.size_bytes || !equalBytes(entry.content, expected.content);
        })) {
      fail("ARCHIVE_PACKAGE_PORT_INVALID", "PackagePort 未返回确定性闭环包");
    }
    const withoutHash: Omit<ArchivePackageReceipt, "receipt_hash"> = {
      schema_version: 2,
      package_operation_id: packageOperationId,
      operation_id: localReceipt.operation_id,
      change_identity: localReceipt.change_identity,
      closure_disposition: localReceipt.closure_disposition,
      archive_intent: localReceipt.archive_intent,
      source_snapshot_hash: localReceipt.source_snapshot_hash,
      source_manifest_hash: localReceipt.archive_manifest_hash,
      source_receipt_hash: sourceReceiptHash,
      archive_schema_version: localReceipt.archive_schema_version,
      archive_path: localReceipt.archive_path,
      local_archive_completed_at: localReceipt.completed_at,
      local_inventory_hash: inventoryHash,
      projection_hash: projectionHash,
      project_id: projection.project_id,
      project_version: projection.project_version,
      archive_id: projection.archive_id,
      package_schema_version: 2,
      package_sha256: sha256Bytes(packageBytes),
      manifest_sha256: sha256Bytes(manifest),
      package_size_bytes: packageBytes.byteLength,
      entry_count: packageEntries.length,
      entry_paths: packageEntries.map((entry) => entry.path),
      uncompressed_size_bytes: packageEntries.reduce((total, entry) => total + entry.size_bytes, 0),
      source_read_count: sourceReadCount,
      source_bytes_read: sourceBytesRead,
      zip_config: zipConfig,
      completed_at: completedAt
    };
    const receipt = deepFreeze({ ...withoutHash, receipt_hash: stableHash(receiptPayload(withoutHash)) });
    const completionEvidence: ArchivePackageCompletionEvidence = deepFreeze({
      schema_version: 1,
      package_operation_id: packageOperationId,
      operation_id: localReceipt.operation_id,
      immutable_identity: immutableIdentity,
      receipt_hash: receipt.receipt_hash,
      completed_at: completedAt
    });
    const persistedCompletion = await port.persistCompletion(completionEvidence);
    if (!validCompletionEvidence(persistedCompletion, packageOperationId,
      localReceipt.operation_id, immutableIdentity) ||
        stableHash(persistedCompletion) !== stableHash(completionEvidence)) {
      fail("ARCHIVE_PACKAGE_PORT_INVALID", "PackagePort 未持久化精确 completion evidence");
    }
    const result = { package_bytes: packageBytes.slice(), manifest_bytes: manifest.slice(), receipt };
    operationIdentities.set(operationKey, immutableIdentity);
    completed.set(packageOperationId, cloneBuildResult(result));
    return cloneBuildResult(result);
  }

  async function verifyPackage(receipt: ArchivePackageReceipt,
    packageBytes: Uint8Array, expected: {
      readonly local_receipt: LocalArchiveReceipt;
      readonly inventory: PublishedArchiveInventory;
      readonly projection: CoreV2Projection;
    }): Promise<PackageVerification> {
    const reasons: ArchivePackageReasonCode[] = [];
    try {
      validateReceiptAndInventory(expected.local_receipt, expected.inventory);
      validateInventoryPaths(expected.inventory);
      validateProjection(expected.projection);
      validateProjectionPaths(expected.projection, expected.inventory);
      const expectedReceiptHash = stableHash(expected.local_receipt);
      const expectedInventoryHash = stableHash(expected.inventory.files.map(({ path, content_hash, size_bytes }) =>
        ({ path, content_hash, size_bytes })).sort((left, right) => compareCodepoint(left.path, right.path)));
      const expectedProjectionHash = stableHash({ schema_version: expected.projection.schema_version,
        project_id: expected.projection.project_id, project_version: expected.projection.project_version,
        archive_id: expected.projection.archive_id,
        files: expected.projection.files.map(({ path, content_hash, size_bytes }) =>
          ({ path, content_hash, size_bytes })).sort((left, right) => compareCodepoint(left.path, right.path)) });
      const expectedOperationId = `archive_package_operation:${stableHash({
        source_receipt_hash: expectedReceiptHash, local_inventory_hash: expectedInventoryHash,
        projection_hash: expectedProjectionHash, package_schema_version: 2
      }).slice("sha256:".length)}` as const;
      const expectedImmutableIdentity = `sha256:${expectedOperationId.slice(
        "archive_package_operation:".length)}` as const;
      const trustedCompletionEvidence = await port.readCompletion(expectedOperationId);
      const { receipt_hash: ignored, ...payload } = receipt;
      void ignored;
      if (!validCompletionEvidence(trustedCompletionEvidence, expectedOperationId,
        expected.local_receipt.operation_id, expectedImmutableIdentity) ||
          receipt.schema_version !== 2 || receipt.package_schema_version !== 2 ||
          !sameConfig(receipt.zip_config) || stableHash(receiptPayload(payload)) !== receipt.receipt_hash ||
          receipt.package_operation_id !== expectedOperationId || receipt.source_receipt_hash !== expectedReceiptHash ||
          receipt.local_inventory_hash !== expectedInventoryHash || receipt.projection_hash !== expectedProjectionHash ||
          receipt.operation_id !== expected.local_receipt.operation_id ||
          receipt.change_identity !== expected.local_receipt.change_identity ||
          receipt.closure_disposition !== expected.local_receipt.closure_disposition ||
          receipt.archive_intent !== expected.local_receipt.archive_intent ||
          receipt.source_snapshot_hash !== expected.local_receipt.source_snapshot_hash ||
          receipt.source_manifest_hash !== expected.local_receipt.archive_manifest_hash ||
          receipt.archive_schema_version !== expected.local_receipt.archive_schema_version ||
          receipt.archive_path !== expected.local_receipt.archive_path ||
          receipt.local_archive_completed_at !== expected.local_receipt.completed_at ||
          receipt.project_id !== expected.projection.project_id ||
          receipt.project_version !== expected.projection.project_version ||
          receipt.archive_id !== expected.projection.archive_id ||
          receipt.completed_at !== trustedCompletionEvidence.completed_at) {
        return deepFreeze({ valid: false, reason_codes: ["ARCHIVE_PACKAGE_RECEIPT_INVALID"] });
      }

      let sourceManifest: Uint8Array | undefined;
      let sourceReadCount = 0;
      let sourceBytesRead = 0;
      const expectedDataEntries: ArchivePackageEntry[] = [];
      for (const declared of [...expected.inventory.files]
        .sort((left, right) => compareCodepoint(left.path, right.path))) {
        const read = await readDeclaredContent(declared.read_content.bind(declared));
        sourceReadCount += 1;
        sourceBytesRead += read.size_bytes;
        if (read.size_bytes !== declared.size_bytes ||
            (declared.path !== manifestPath && read.content_hash !== declared.content_hash)) {
          fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "可信本地 inventory 内容漂移");
        }
        if (declared.path === manifestPath) sourceManifest = read.content;
        else if (coreV2Path(declared.path) && classifierAllows(declared.path)) {
          expectedDataEntries.push({ path: declared.path, content: read.content.slice(),
            content_hash: read.content_hash, size_bytes: read.size_bytes });
        }
      }
      if (sourceManifest === undefined) fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "可信本地 inventory 缺少 manifest");
      validateSourceManifest(sourceManifest, expected.local_receipt, expected.inventory);
      for (const declared of [...expected.projection.files]
        .sort((left, right) => compareCodepoint(left.path, right.path))) {
        if (!coreV2Path(declared.path) || !classifierAllows(declared.path)) continue;
        const read = await readDeclaredContent(declared.read_content.bind(declared));
        sourceReadCount += 1;
        sourceBytesRead += read.size_bytes;
        if (read.size_bytes !== declared.size_bytes || read.content_hash !== declared.content_hash) {
          fail("ARCHIVE_PACKAGE_SOURCE_INVALID", "可信 projection 内容漂移");
        }
        expectedDataEntries.push({ path: declared.path, content: read.content.slice(),
          content_hash: read.content_hash, size_bytes: read.size_bytes });
      }
      validateCandidates(expectedDataEntries, expected.local_receipt, expected.projection);
      const expectedManifest = manifestBytes(expected.local_receipt, expected.projection, expectedReceiptHash,
        expectedInventoryHash, expectedProjectionHash, sourceReadCount, sourceBytesRead,
        trustedCompletionEvidence.completed_at, expectedDataEntries);
      const expectedEntries = [...expectedDataEntries, { path: manifestPath, content: expectedManifest,
        content_hash: sha256Bytes(expectedManifest), size_bytes: expectedManifest.byteLength }]
        .sort((left, right) => compareCodepoint(left.path, right.path));
      const inspected = await port.inspect(packageBytes);
      const inspectedPaths = new Set<string>();
      const foldedPaths = new Set<string>();
      if (!sameConfig(inspected.zip_config) || inspected.entries.length !== expectedEntries.length ||
          inspected.entries.some((entry, index) => {
            const expectedEntry = expectedEntries[index];
            const folded = entry.path.normalize("NFC").toLowerCase();
            const validPath = canonicalPackagePath(entry.path) && !inspectedPaths.has(entry.path) && !foldedPaths.has(folded) &&
              (entry.path === manifestPath || (coreV2Path(entry.path) && classifierAllows(entry.path)));
            inspectedPaths.add(entry.path);
            foldedPaths.add(folded);
            return !validPath || expectedEntry === undefined || entry.path !== expectedEntry.path ||
              entry.content_hash !== expectedEntry.content_hash || entry.size_bytes !== expectedEntry.size_bytes ||
              !equalBytes(entry.content, expectedEntry.content);
          })) {
        reasons.push("ARCHIVE_PACKAGE_VERIFICATION_FAILED");
      } else {
        validateCandidates(inspected.entries.filter((entry) => entry.path !== manifestPath),
          expected.local_receipt, expected.projection);
        const expectedPackageBytes = await port.build(expectedEntries, zipConfig);
        const expectedWithoutHash: Omit<ArchivePackageReceipt, "receipt_hash"> = {
          schema_version: 2, package_operation_id: expectedOperationId,
          operation_id: expected.local_receipt.operation_id,
          change_identity: expected.local_receipt.change_identity,
          closure_disposition: expected.local_receipt.closure_disposition,
          archive_intent: expected.local_receipt.archive_intent,
          source_snapshot_hash: expected.local_receipt.source_snapshot_hash,
          source_manifest_hash: expected.local_receipt.archive_manifest_hash,
          source_receipt_hash: expectedReceiptHash,
          archive_schema_version: expected.local_receipt.archive_schema_version,
          archive_path: expected.local_receipt.archive_path,
          local_archive_completed_at: expected.local_receipt.completed_at,
          local_inventory_hash: expectedInventoryHash, projection_hash: expectedProjectionHash,
          project_id: expected.projection.project_id, project_version: expected.projection.project_version,
          archive_id: expected.projection.archive_id, package_schema_version: 2,
          package_sha256: sha256Bytes(expectedPackageBytes), manifest_sha256: sha256Bytes(expectedManifest),
          package_size_bytes: expectedPackageBytes.byteLength, entry_count: expectedEntries.length,
          entry_paths: expectedEntries.map((entry) => entry.path),
          uncompressed_size_bytes: expectedEntries.reduce((total, entry) => total + entry.size_bytes, 0),
          source_read_count: sourceReadCount, source_bytes_read: sourceBytesRead,
          zip_config: zipConfig, completed_at: trustedCompletionEvidence.completed_at
        };
        const fullyExpectedReceipt = { ...expectedWithoutHash,
          receipt_hash: stableHash(receiptPayload(expectedWithoutHash)) };
        if (!equalBytes(packageBytes, expectedPackageBytes) ||
            trustedCompletionEvidence.receipt_hash !== receipt.receipt_hash ||
            stableHash(receipt) !== stableHash(fullyExpectedReceipt)) {
          reasons.push("ARCHIVE_PACKAGE_RECEIPT_INVALID");
        }
      }
    } catch {
      reasons.push("ARCHIVE_PACKAGE_VERIFICATION_FAILED");
    }
    return deepFreeze({ valid: reasons.length === 0, reason_codes: [...new Set(reasons)] });
  }

  return { buildPackage, verifyPackage };
}
