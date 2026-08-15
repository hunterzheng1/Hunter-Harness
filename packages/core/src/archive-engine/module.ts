import { classifyContentPath } from "@hunter-harness/contracts";
import { plannedPhaseSetSchema } from "../plan-classification/index.js";

import { ArchiveEngineError } from "./errors.js";
import { isSha256, normalizeArchiveRecord } from "./compatibility.js";
import { compareCodepoint, contentHash, deepFreeze, stableHash, stableJson } from "./stable.js";
import type {
  ArchiveBlocker,
  ArchiveChangeRef,
  ArchiveEngine,
  ArchiveExpectedOutput,
  ArchiveFilePayload,
  ArchiveInventoryItem,
  ArchiveLocalPort,
  ArchiveOperationRecord,
  ArchivePhaseOutcome,
  ArchivePlan,
  ArchiveReasonCode,
  ArchiveReconcileResult,
  ArchiveSnapshot,
  ArchiveStage,
  ClosurePolicy,
  LocalArchiveReceipt,
  Sha256
} from "./types.js";

const encoder = new TextEncoder();
const machineSlug = /^[a-z][a-z0-9_]*(?:[./-][a-z0-9_]+)*$/u;
const operationId = /^archive_operation:[a-f0-9]{64}$/u;
const archivePath = /^\.harness\/archive\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const packageAuthNames = new Set([
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", ".netrc", ".git-credentials",
  "pip.conf", "settings.xml", "gradle.properties", "nuget.config"
]);
const generatedPaths = [
  "summary/change-summary.json",
  "attestations/verification.json",
  "archive-meta.json",
  "archive-manifest.json"
] as const;

function bytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content.slice();
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(stableJson(value) + "\n");
}

function requireInput(condition: boolean, code: ArchiveReasonCode, message: string): void {
  if (!condition) throw new ArchiveEngineError(code, "irrecoverable", message, false);
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) <= 31);
}

function validateChange(change: ArchiveChangeRef): void {
  requireInput(change.schema_version === 1 && change.archive_schema_version === 1,
    "ARCHIVE_INPUT_INVALID", "归档输入版本无效");
  requireInput(typeof change.change_identity === "string" &&
    change.change_identity.trim() !== "" && !change.change_identity.includes("\\") &&
    !hasControlCharacter(change.change_identity),
  "ARCHIVE_INPUT_INVALID", "Change 身份无效");
  requireInput(archivePath.test(change.archive_path),
    "ARCHIVE_PATH_INVALID", "归档路径必须位于 .harness/archive 下");
  requireInput(change.max_archive_bytes === undefined ||
    (Number.isSafeInteger(change.max_archive_bytes) && change.max_archive_bytes > 0),
  "ARCHIVE_INPUT_INVALID", "归档预算必须是正安全整数");
}

function validatePolicy(policy: ClosurePolicy): void {
  requireInput(policy.schema_version === 1,
    "ARCHIVE_INPUT_INVALID", "关闭策略版本无效");
  requireInput(["completed", "abandoned", "superseded"].includes(policy.disposition),
    "ARCHIVE_INPUT_INVALID", "结束方式无效");
  requireInput(["release_candidate", "record_only"].includes(policy.archive_intent),
    "ARCHIVE_INPUT_INVALID", "归档意图无效");
  const phases = policy.available_evidence.phase_terminals;
  requireInput(Array.isArray(phases) && phases.every((item) =>
    machineSlug.test(item.phase) &&
    ["passed", "warning", "failed", "blocked", "not_run"].includes(item.status) &&
    (item.evidence_hash === undefined || isSha256(item.evidence_hash))),
  "ARCHIVE_INPUT_INVALID", "阶段终态证据无效");
  requireInput(new Set(phases.map((item) => item.phase)).size === phases.length,
    "ARCHIVE_INPUT_INVALID", "阶段终态不能重复");
  const ref = policy.planned_phase_set_ref;
  if (ref !== undefined) {
    const parsed = plannedPhaseSetSchema.safeParse(ref);
    requireInput(parsed.success && parsed.data.outcome === "configured",
      "ARCHIVE_INPUT_INVALID", "计划阶段引用必须是可发布的完整 PlannedPhaseSet");
  }
}

function collisionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function pathExclusion(path: string): ArchiveReasonCode | undefined {
  const classified = classifyContentPath({ schema_version: 1, path });
  if (!("content_kind" in classified)) {
    if (classified.reason_code === "CONTENT_PATH_ENV_EXCLUDED") {
      return "ARCHIVE_ENV_PATH_EXCLUDED" as ArchiveReasonCode;
    }
    if (classified.reason_code === "CONTENT_PATH_CREDENTIALS_EXCLUDED") {
      return "ARCHIVE_CREDENTIAL_PATH_EXCLUDED" as ArchiveReasonCode;
    }
    if (classified.reason_code === "CONTENT_PATH_VCS_EXCLUDED") {
      return "ARCHIVE_VCS_PATH_EXCLUDED" as ArchiveReasonCode;
    }
    if (classified.reason_code.endsWith("RUNTIME_EXCLUDED") ||
        classified.reason_code.endsWith("STATE_EXCLUDED")) {
      return "ARCHIVE_RUNTIME_PATH_EXCLUDED" as ArchiveReasonCode;
    }
    if (classified.reason_code === "CONTENT_PATH_UNCLASSIFIED") return undefined;
    throw new ArchiveEngineError(
      "ARCHIVE_PATH_INVALID", "irrecoverable", `归档来源路径无效：${path}`, false
    );
  }
  const segments = path.toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  if (packageAuthNames.has(basename) ||
      /^(?:credentials?|client[-_]secret)(?:\.[^./]+)*$/u.test(basename) ||
      /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*(?:private[-_]?key|\.key|\.p12|\.pfx)|private[^/]*\.pem)$/u
        .test(basename)) {
    return "ARCHIVE_CREDENTIAL_PATH_EXCLUDED" as ArchiveReasonCode;
  }
  return undefined;
}

interface InventoriedSnapshot {
  source_snapshot_hash: Sha256;
  included: ArchiveFilePayload[];
  excluded: ArchivePlan["excluded_items"];
  input_file_count: number;
  input_size_bytes: number;
}

function inventory(snapshot: ArchiveSnapshot): InventoriedSnapshot {
  const seen = new Set<string>();
  const canonicalSeen = new Map<string, string>();
  const generatedKeys = new Set(generatedPaths.map(collisionKey));
  const included: ArchiveFilePayload[] = [];
  const excluded: Array<ArchivePlan["excluded_items"][number]> = [];
  const all: Array<ArchiveInventoryItem> = [];
  for (const file of [...snapshot.files].sort((left, right) =>
    compareCodepoint(left.path, right.path)
  )) {
    requireInput(typeof file.path === "string" && file.path !== "" && !seen.has(file.path),
      "ARCHIVE_PATH_INVALID", "归档来源路径为空或重复");
    const key = collisionKey(file.path);
    requireInput(!generatedKeys.has(key),
      "ARCHIVE_PATH_INVALID", `归档来源不能占用生成路径：${file.path}`);
    const collidingPath = canonicalSeen.get(key);
    requireInput(collidingPath === undefined,
      "ARCHIVE_PATH_INVALID", `归档来源路径冲突：${collidingPath ?? ""} / ${file.path}`);
    canonicalSeen.set(key, file.path);
    seen.add(file.path);
    const payload = bytes(file.content);
    const item = {
      path: file.path,
      content_hash: contentHash(payload),
      size_bytes: payload.byteLength
    } satisfies ArchiveInventoryItem;
    all.push(item);
    const reason = pathExclusion(file.path);
    if (reason !== undefined) {
      excluded.push({
        path: file.path,
        reason_code: reason as ArchivePlan["excluded_items"][number]["reason_code"]
      });
    } else {
      included.push({ ...item, content: payload });
    }
  }
  return {
    source_snapshot_hash: stableHash({
      change_identity: snapshot.change_identity,
      files: all
    }),
    included,
    excluded,
    input_file_count: all.length,
    input_size_bytes: all.reduce((total, item) => total + item.size_bytes, 0)
  };
}

function blocker(
  reason_code: ArchiveReasonCode,
  classification: ArchiveBlocker["classification"],
  message_zh: string,
  phase?: string
): ArchiveBlocker {
  return { reason_code, classification, message_zh, ...(phase === undefined ? {} : { phase }) };
}

function closureBlockers(change: ArchiveChangeRef, policy: ClosurePolicy,
  inventoried: InventoriedSnapshot): ArchiveBlocker[] {
  const blockers: ArchiveBlocker[] = [];
  const ref = policy.planned_phase_set_ref;
  const outcomes = new Map(policy.available_evidence.phase_terminals.map((item) =>
    [item.phase, item]
  ));
  if (policy.disposition === "completed") {
    if (ref === undefined) {
      blockers.push(blocker("PLANNED_PHASE_SET_REQUIRED", "auto_fixable",
        "完成归档需要计划阶段集合"));
    } else {
      const planned = new Set<string>(ref.planned_phases);
      for (const phase of ref.planned_phases) {
        if (phase === "archive") continue;
        const outcome = outcomes.get(phase);
        if (outcome === undefined || outcome.status === "not_run") {
          blockers.push(blocker("PLANNED_PHASE_TERMINAL_MISSING", "auto_fixable",
            `计划阶段 ${phase} 缺少终态`, phase));
        } else if (policy.archive_intent === "release_candidate" &&
            !["passed", "warning"].includes(outcome.status)) {
          blockers.push(blocker("PLANNED_PHASE_NOT_SUCCESSFUL", "release_only",
            `发布候选的计划阶段 ${phase} 未成功`, phase));
        }
      }
      for (const outcome of policy.available_evidence.phase_terminals) {
        if (!planned.has(outcome.phase) && outcome.status !== "not_run") {
          blockers.push(blocker("UNPLANNED_PHASE_MUST_BE_NOT_RUN", "auto_fixable",
            `未计划阶段 ${outcome.phase} 只能记录为 not_run`, outcome.phase));
        }
      }
    }
  } else {
    if (policy.archive_intent === "release_candidate") {
      blockers.push(blocker("UNFINISHED_RELEASE_INTENT_FORBIDDEN", "user_choice",
        "未完成变更只能按事实记录归档"));
    }
    const reason = policy.available_evidence.termination_reason_zh?.trim() ?? "";
    if (policy.disposition === "abandoned" &&
        (reason === "" || !/[\u3400-\u9fff]/u.test(reason))) {
      blockers.push(blocker("TERMINATION_REASON_REQUIRED", "user_choice",
        "放弃变更需要中文终止原因"));
    }
    if (policy.disposition === "superseded" &&
        (policy.available_evidence.superseded_by?.trim() ?? "") === "" &&
        (reason === "" || !/[\u3400-\u9fff]/u.test(reason))) {
      blockers.push(blocker("SUPERSESSION_REFERENCE_REQUIRED", "user_choice",
        "被替代变更需要替代对象或中文原因"));
    }
  }
  if (policy.archive_intent === "release_candidate" && policy.disposition === "completed") {
    const release = policy.available_evidence.release;
    const checks: Array<[boolean, ArchiveReasonCode, string]> = [
      [release?.git_repository === true, "RELEASE_GIT_REQUIRED", "发布候选需要 Git 仓库证据"],
      [release?.upstream_configured === true, "RELEASE_UPSTREAM_REQUIRED", "发布候选需要 upstream"],
      [release?.source_committed === true, "RELEASE_COMMIT_REQUIRED", "发布候选需要已提交源码"],
      [release?.source_pushed === true, "RELEASE_PUSH_REQUIRED", "发布候选需要已推送源码"],
      [release?.ci_passed === true, "RELEASE_CI_REQUIRED", "发布候选需要 CI 通过"],
      [release?.candidate_verified === true, "RELEASE_CANDIDATE_PROOF_REQUIRED",
        "发布候选需要候选制品证明"]
    ];
    for (const [passed, reasonCode, message] of checks) {
      if (!passed) blockers.push(blocker(reasonCode, "release_only", message));
    }
  }
  if (change.max_archive_bytes !== undefined &&
      inventoried.included.reduce((sum, item) => sum + item.size_bytes, 0) >
        change.max_archive_bytes) {
    blockers.push(blocker("ARCHIVE_BUDGET_EXCEEDED", "user_choice",
      "归档内容超过已确认预算"));
  }
  return blockers;
}

function orderedOutcomes(policy: ClosurePolicy): ArchivePhaseOutcome[] {
  const byPhase = new Map(policy.available_evidence.phase_terminals.map((item) =>
    [item.phase, item]
  ));
  const planned = policy.planned_phase_set_ref?.planned_phases ?? [];
  const result = planned.flatMap((phase) => {
    const item = byPhase.get(phase);
    return item === undefined ? [] : [item];
  });
  const plannedSet = new Set<string>(planned);
  result.push(...policy.available_evidence.phase_terminals
    .filter((item) => !plannedSet.has(item.phase))
    .sort((left, right) => compareCodepoint(left.phase, right.phase)));
  return result.map((item) => ({ ...item }));
}

function expectedOutputs(included: readonly ArchiveInventoryItem[]): ArchiveExpectedOutput[] {
  return [
    ...included.map((item) => ({ path: item.path, kind: "source" as const })),
    { path: "summary/change-summary.json", kind: "summary" },
    { path: "attestations/verification.json", kind: "attestation" },
    { path: "archive-meta.json", kind: "metadata" },
    { path: "archive-manifest.json", kind: "manifest" }
  ];
}

function createPlan(change: ArchiveChangeRef, policy: ClosurePolicy,
  inventoried: InventoriedSnapshot): ArchivePlan {
  const closurePolicyHash = stableHash(policy);
  const operation = stableHash({
    change_identity: change.change_identity,
    source_snapshot_hash: inventoried.source_snapshot_hash,
    archive_schema_version: change.archive_schema_version
  });
  const operation_id = `archive_operation:${operation.slice("sha256:".length)}` as const;
  const included_items = inventoried.included.map((item) => ({
    path: item.path,
    content_hash: item.content_hash,
    size_bytes: item.size_bytes
  }));
  const raw = {
    schema_version: 1 as const,
    operation_id,
    change_identity: change.change_identity,
    closure_disposition: policy.disposition,
    archive_intent: policy.archive_intent,
    archive_schema_version: change.archive_schema_version,
    archive_path: change.archive_path,
    closure_policy_hash: closurePolicyHash,
    source_snapshot_hash: inventoried.source_snapshot_hash,
    ...(policy.planned_phase_set_ref === undefined
      ? {}
      : { planned_phase_set_ref: policy.planned_phase_set_ref }),
    phase_outcomes: orderedOutcomes(policy),
    included_items,
    excluded_items: inventoried.excluded,
    blockers: closureBlockers(change, policy, inventoried),
    warnings: inventoried.excluded.length === 0 ? [] : ["ARCHIVE_SOURCE_ITEMS_EXCLUDED"],
    expected_outputs: expectedOutputs(included_items)
  };
  return deepFreeze({ ...raw, plan_hash: stableHash(raw) });
}

function validatePlan(plan: ArchivePlan): void {
  requireInput(plan.schema_version === 1 && operationId.test(plan.operation_id) &&
    isSha256(plan.plan_hash) && isSha256(plan.closure_policy_hash) &&
    isSha256(plan.source_snapshot_hash) && archivePath.test(plan.archive_path),
  "ARCHIVE_PLAN_INVALID", "归档计划结构无效");
  const payload = { ...plan } as Omit<ArchivePlan, "plan_hash"> & { plan_hash?: Sha256 };
  delete payload.plan_hash;
  requireInput(stableHash(payload) === plan.plan_hash,
    "ARCHIVE_PLAN_INVALID", "归档计划哈希不匹配");
}

interface Artifacts {
  stage: ArchiveStage;
}

function buildArtifacts(record: ArchiveOperationRecord,
  inventoried: InventoriedSnapshot): Artifacts {
  const files = new Map<string, Uint8Array>();
  for (const item of inventoried.included) files.set(item.path, item.content);
  const summary = {
    schema_version: 1,
    change_identity: record.change_identity,
    closure_disposition: record.plan.closure_disposition,
    archive_intent: record.plan.archive_intent,
    planned_phases: record.plan.planned_phase_set_ref?.planned_phases ?? [],
    source_snapshot_hash: record.source_snapshot_hash,
    file_count: inventoried.input_file_count,
    input_size_bytes: inventoried.input_size_bytes
  };
  const verification = {
    schema_version: 1,
    closure_policy_hash: record.plan.closure_policy_hash,
    phase_outcomes: record.plan.phase_outcomes,
    blockers: record.plan.blockers,
    warnings: record.plan.warnings
  };
  const metadata = {
    schema_version: 1,
    operation_id: record.operation_id,
    change_identity: record.change_identity,
    archive_schema_version: record.archive_schema_version,
    source_snapshot_hash: record.source_snapshot_hash
  };
  files.set("summary/change-summary.json", jsonBytes(summary));
  files.set("attestations/verification.json", jsonBytes(verification));
  files.set("archive-meta.json", jsonBytes(metadata));
  const manifest = {
    schema_version: 1,
    operation_id: record.operation_id,
    change_identity: record.change_identity,
    source_snapshot_hash: record.source_snapshot_hash,
    files: [...files.entries()]
      .map(([path, content]) => ({
        path,
        content_hash: contentHash(content),
        size_bytes: content.byteLength
      }))
      .sort((left, right) => compareCodepoint(left.path, right.path))
  };
  const manifestPayload = jsonBytes(manifest);
  const archiveManifestHash = contentHash(manifestPayload);
  files.set("archive-manifest.json", manifestPayload);
  return {
    stage: {
      operation_id: record.operation_id,
      change_identity: record.change_identity,
      source_snapshot_hash: record.source_snapshot_hash,
      archive_path: record.plan.archive_path,
      archive_manifest_hash: archiveManifestHash,
      files
    }
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) =>
    value === right[index]
  );
}

function verifyArchiveFiles(
  archive: ArchiveStage,
  record: ArchiveOperationRecord,
  code: "ARCHIVE_STAGE_INVALID" | "ARCHIVE_IMMUTABLE_CONFLICT"
): Sha256 {
  const fail = (message: string): never => {
    throw new ArchiveEngineError(code, "irrecoverable", message, false);
  };
  if (archive.operation_id !== record.operation_id ||
      archive.change_identity !== record.change_identity ||
      archive.source_snapshot_hash !== record.source_snapshot_hash ||
      archive.archive_path !== record.plan.archive_path) {
    fail("归档结构身份不匹配");
  }
  const maybeManifestPayload = archive.files.get("archive-manifest.json");
  if (maybeManifestPayload === undefined) {
    fail("归档缺少 manifest payload");
  }
  const manifestPayload = maybeManifestPayload as Uint8Array;
  if (contentHash(manifestPayload) !== archive.archive_manifest_hash) {
    fail("归档 manifest payload 哈希不匹配");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestPayload));
  } catch {
    fail("归档 manifest 无法解析");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("归档 manifest 结构无效");
  }
  const manifest = parsed as Record<string, unknown>;
  const rawManifestFiles = manifest.files;
  if (Object.keys(manifest).sort(compareCodepoint).join("\0") !==
      ["change_identity", "files", "operation_id", "schema_version", "source_snapshot_hash"]
        .sort(compareCodepoint).join("\0") ||
      manifest.schema_version !== 1 || manifest.operation_id !== record.operation_id ||
      manifest.change_identity !== record.change_identity ||
      manifest.source_snapshot_hash !== record.source_snapshot_hash ||
      !Array.isArray(rawManifestFiles)) {
    fail("归档 manifest 身份或字段无效");
  }
  const manifestFiles = rawManifestFiles as unknown[];
  if (!equalBytes(manifestPayload, jsonBytes(manifest))) {
    fail("归档 manifest 不是 canonical payload");
  }
  const declared = new Set<string>();
  let previousPath: string | undefined;
  for (const raw of manifestFiles) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      fail("归档 manifest entry 无效");
    }
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).sort(compareCodepoint).join("\0") !==
        ["content_hash", "path", "size_bytes"].sort(compareCodepoint).join("\0") ||
        typeof item.path !== "string" || !isSha256(item.content_hash) ||
        !Number.isSafeInteger(item.size_bytes) || (item.size_bytes as number) < 0 ||
        item.path === "archive-manifest.json" || declared.has(item.path) ||
        (previousPath !== undefined && compareCodepoint(previousPath, item.path) >= 0)) {
      fail("归档 manifest entry 字段、路径或顺序无效");
    }
    const itemPath = item.path as string;
    const itemHash = item.content_hash as Sha256;
    const itemSize = item.size_bytes as number;
    const payload = archive.files.get(itemPath);
    if (payload === undefined || payload.byteLength !== itemSize ||
        contentHash(payload) !== itemHash) {
      fail(`归档文件 ${itemPath} 与 manifest 不一致`);
    }
    declared.add(itemPath);
    previousPath = itemPath;
  }
  const actualPaths = [...archive.files.keys()]
    .filter((path) => path !== "archive-manifest.json")
    .sort(compareCodepoint);
  if (actualPaths.length !== declared.size || actualPaths.some((path) => !declared.has(path))) {
    fail("归档文件集合与 manifest 不闭合");
  }
  return archive.archive_manifest_hash;
}

function assertReceiptMatches(
  receipt: LocalArchiveReceipt,
  record: ArchiveOperationRecord,
  manifestHash: Sha256
): LocalArchiveReceipt {
  const normalized = normalizeArchiveRecord(receipt);
  if (!normalized.ok || normalized.source_schema_version !== 1 ||
      normalized.receipt.operation_id !== record.operation_id ||
      normalized.receipt.change_identity !== record.change_identity ||
      normalized.receipt.closure_disposition !== record.plan.closure_disposition ||
      normalized.receipt.archive_intent !== record.plan.archive_intent ||
      normalized.receipt.source_snapshot_hash !== record.source_snapshot_hash ||
      normalized.receipt.archive_schema_version !== record.archive_schema_version ||
      normalized.receipt.archive_path !== record.plan.archive_path ||
      normalized.receipt.archive_manifest_hash !== manifestHash ||
      record.completed_at === undefined ||
      normalized.receipt.completed_at !== record.completed_at) {
    throw new ArchiveEngineError(
      "ARCHIVE_IMMUTABLE_CONFLICT", "irrecoverable", "本地归档收据与 operation 不匹配", false
    );
  }
  return receipt;
}

function primaryClassification(blockers: readonly ArchiveBlocker[]): ArchiveBlocker["classification"] {
  const rank = ["irrecoverable", "user_choice", "release_only", "auto_fixable"] as const;
  return rank.find((classification) => blockers.some((item) =>
    item.classification === classification
  )) ?? "auto_fixable";
}

export function createArchiveEngine(input: {
  port: ArchiveLocalPort;
  clock?: (() => Date) | undefined;
  owner_id: string;
  lease_ms?: number | undefined;
}): ArchiveEngine {
  const port = input.port;
  const clock = input.clock ?? (() => new Date());
  const leaseMs = input.lease_ms ?? 60_000;
  requireInput(input.owner_id.trim() !== "" && Number.isSafeInteger(leaseMs) && leaseMs > 0,
    "ARCHIVE_INPUT_INVALID", "Archive Engine 配置无效");

  function leaseExpiry(): string {
    return new Date(clock().getTime() + leaseMs).toISOString();
  }

  async function prepareArchive(
    change: ArchiveChangeRef,
    policy: ClosurePolicy
  ): Promise<ArchivePlan> {
    validateChange(change);
    validatePolicy(policy);
    const snapshot = await port.readChangeSnapshot(change.change_identity);
    requireInput(snapshot.change_identity === change.change_identity,
      "ARCHIVE_INPUT_INVALID", "Change 快照身份不匹配");
    const plan = createPlan(change, policy, inventory(snapshot));
    const existing = await port.loadOperation(plan.operation_id);
    if (existing?.plan.plan_hash === plan.plan_hash) return existing.plan;
    if (existing?.status === "locally_archived" && existing.plan.plan_hash !== plan.plan_hash) {
      throw new ArchiveEngineError(
        "ARCHIVE_IMMUTABLE_CONFLICT", "irrecoverable", "不可变归档已使用不同关闭策略", false
      );
    }
    await port.saveOperation({
      operation_id: plan.operation_id,
      change_identity: plan.change_identity,
      source_snapshot_hash: plan.source_snapshot_hash,
      archive_schema_version: plan.archive_schema_version,
      plan,
      status: "prepared",
      owner_id: input.owner_id,
      lease_expires_at: leaseExpiry(),
      quiesced: false,
      receipt_written: false,
      terminal_event_written: false
    });
    return plan;
  }

  async function finishPublished(record: ArchiveOperationRecord,
    manifestHash: Sha256): Promise<LocalArchiveReceipt> {
    const published = await port.inspectArchive(record.plan.archive_path);
    if (published === undefined || published.operation_id !== record.operation_id ||
        published.change_identity !== record.change_identity ||
        published.archive_manifest_hash !== manifestHash) {
      throw new ArchiveEngineError(
        "ARCHIVE_IMMUTABLE_CONFLICT", "irrecoverable", "已发布归档身份或哈希不匹配", false
      );
    }
    verifyArchiveFiles({ ...published, source_snapshot_hash: record.source_snapshot_hash },
      record, "ARCHIVE_IMMUTABLE_CONFLICT");
    const existingReceipt = await port.loadReceipt(record.operation_id);
    let completedAt = record.completed_at;
    if (completedAt === undefined) {
      if (existingReceipt !== undefined) {
        throw new ArchiveEngineError(
          "ARCHIVE_IMMUTABLE_CONFLICT", "irrecoverable", "本地归档缺少可信完成时间证据", false
        );
      }
      completedAt = clock().toISOString();
      record = { ...record, completed_at: completedAt };
      await port.saveOperation(record);
    }
    const receipt: LocalArchiveReceipt = existingReceipt === undefined
      ? deepFreeze({
        schema_version: 1,
        operation_id: record.operation_id,
        change_identity: record.change_identity,
        closure_disposition: record.plan.closure_disposition,
        archive_intent: record.plan.archive_intent,
        source_snapshot_hash: record.source_snapshot_hash,
        archive_schema_version: record.archive_schema_version,
        archive_path: record.plan.archive_path,
        archive_manifest_hash: manifestHash,
        completed_at: completedAt
      })
      : assertReceiptMatches(existingReceipt, record, manifestHash);
    if (existingReceipt === undefined) {
      await port.writeReceipt(receipt);
    }
    record = { ...record, status: "receipt_written", receipt_written: true };
    await port.saveOperation(record);
    if (!record.terminal_event_written) {
      await port.appendTerminalEvent({
        schema_version: 1,
        event_type: "archive.locally_archived",
        operation_id: record.operation_id,
        change_identity: record.change_identity,
        archive_manifest_hash: manifestHash,
        occurred_at: receipt.completed_at
      });
    }
    await port.saveOperation({
      ...record,
      status: "locally_archived",
      terminal_event_written: true,
      published_manifest_hash: manifestHash
    });
    return receipt;
  }

  async function continueOperation(record: ArchiveOperationRecord,
    checkSource: boolean): Promise<LocalArchiveReceipt> {
    const existingReceipt = await port.loadReceipt(record.operation_id);
    if (record.status === "locally_archived" && existingReceipt !== undefined) {
      const archived = await port.inspectArchive(record.plan.archive_path);
      const expected = record.published_manifest_hash ?? existingReceipt.archive_manifest_hash;
      if (archived === undefined) {
        throw new ArchiveEngineError(
          "ARCHIVE_IMMUTABLE_CONFLICT", "irrecoverable", "本地终态缺少不可变归档", false
        );
      }
      const actual = verifyArchiveFiles(
        { ...archived, source_snapshot_hash: record.source_snapshot_hash },
        record,
        "ARCHIVE_IMMUTABLE_CONFLICT"
      );
      if (actual !== expected) {
        throw new ArchiveEngineError(
          "ARCHIVE_IMMUTABLE_CONFLICT", "irrecoverable", "本地终态的 manifest 哈希不匹配", false
        );
      }
      return assertReceiptMatches(existingReceipt, record, expected);
    }
    const published = await port.inspectArchive(record.plan.archive_path);
    if (published !== undefined) {
      const expected = record.published_manifest_hash ?? record.staged_manifest_hash;
      if (expected === undefined || published.operation_id !== record.operation_id ||
          published.change_identity !== record.change_identity ||
          published.archive_manifest_hash !== expected) {
        throw new ArchiveEngineError(
          "ARCHIVE_IMMUTABLE_CONFLICT", "irrecoverable", "现有归档无法按当前 operation 恢复", false
        );
      }
      return finishPublished(record, expected);
    }
    let staged = await port.inspectStage(record.operation_id);
    if (staged === undefined) {
      const snapshot = await port.readChangeSnapshot(record.change_identity);
      const inventoried = inventory(snapshot);
      if (inventoried.source_snapshot_hash !== record.source_snapshot_hash) {
        await port.saveOperation({ ...record, status: "stale", reason_code: "ARCHIVE_PLAN_STALE" });
        throw new ArchiveEngineError(
          "ARCHIVE_PLAN_STALE", "user_choice", "输入已变化，请重新确认归档计划", true
        );
      }
      if (checkSource && !record.quiesced) {
        await port.quiesce(record.change_identity, record.operation_id);
        record = { ...record, quiesced: true, lease_expires_at: leaseExpiry() };
        await port.saveOperation(record);
      }
      const artifacts = buildArtifacts(record, inventoried);
      record = { ...record, status: "staging", lease_expires_at: leaseExpiry() };
      await port.saveOperation(record);
      await port.writeStage(artifacts.stage);
      staged = artifacts.stage;
      record = {
        ...record,
        status: "validating",
        staged_manifest_hash: staged.archive_manifest_hash,
        lease_expires_at: leaseExpiry()
      };
      await port.saveOperation(record);
    } else {
      if (staged.change_identity !== record.change_identity ||
          staged.source_snapshot_hash !== record.source_snapshot_hash ||
          staged.archive_path !== record.plan.archive_path ||
          (record.staged_manifest_hash !== undefined &&
           record.staged_manifest_hash !== staged.archive_manifest_hash)) {
        throw new ArchiveEngineError(
          "ARCHIVE_STAGE_INVALID", "irrecoverable", "暂存归档身份或哈希不匹配", false
        );
      }
      if (record.staged_manifest_hash === undefined) {
        record = { ...record, status: "validating", staged_manifest_hash: staged.archive_manifest_hash };
        await port.saveOperation(record);
      }
    }
    verifyArchiveFiles(staged, record, "ARCHIVE_STAGE_INVALID");
    const publishedNow = await port.publishStage(record.operation_id, record.plan.archive_path);
    if (publishedNow.archive_manifest_hash !== staged.archive_manifest_hash) {
      throw new ArchiveEngineError(
        "ARCHIVE_IMMUTABLE_CONFLICT", "irrecoverable", "原子发布返回的哈希不匹配", false
      );
    }
    record = {
      ...record,
      status: "published",
      published_manifest_hash: publishedNow.archive_manifest_hash
    };
    await port.saveOperation(record);
    return finishPublished(record, publishedNow.archive_manifest_hash);
  }

  async function finalizeLocalArchive(plan: ArchivePlan): Promise<LocalArchiveReceipt> {
    validatePlan(plan);
    if (plan.blockers.length > 0) {
      throw new ArchiveEngineError(
        "ARCHIVE_PLAN_BLOCKED",
        primaryClassification(plan.blockers),
        "归档计划包含未解决的阻塞项",
        plan.blockers.some((item) => item.classification !== "irrecoverable")
      );
    }
    const record = await port.loadOperation(plan.operation_id);
    if (record === undefined) {
      throw new ArchiveEngineError(
        "ARCHIVE_OPERATION_NOT_FOUND", "irrecoverable", "找不到归档 operation", false
      );
    }
    if (record.plan.plan_hash !== plan.plan_hash ||
        record.change_identity !== plan.change_identity ||
        record.source_snapshot_hash !== plan.source_snapshot_hash) {
      throw new ArchiveEngineError(
        "ARCHIVE_PLAN_STALE", "user_choice", "归档计划已被替换，请重新确认", true
      );
    }
    return continueOperation(record, true);
  }

  async function resumeArchive(operation_id: string): Promise<LocalArchiveReceipt> {
    if (!operationId.test(operation_id)) {
      throw new ArchiveEngineError(
        "ARCHIVE_OPERATION_NOT_FOUND", "irrecoverable", "归档 operation ID 无效", false
      );
    }
    const record = await port.loadOperation(operation_id);
    if (record === undefined) {
      throw new ArchiveEngineError(
        "ARCHIVE_OPERATION_NOT_FOUND", "irrecoverable", "找不到归档 operation", false
      );
    }
    validatePlan(record.plan);
    if (record.plan.blockers.length > 0) {
      throw new ArchiveEngineError(
        "ARCHIVE_PLAN_BLOCKED", primaryClassification(record.plan.blockers),
        "归档计划包含未解决的阻塞项", true
      );
    }
    return continueOperation(record, true);
  }

  async function reconcileArchive(change_identity: string): Promise<ArchiveReconcileResult> {
    requireInput(change_identity.trim() !== "", "ARCHIVE_INPUT_INVALID", "Change 身份无效");
    const records = [...await port.listOperations(change_identity)]
      .sort((left, right) => compareCodepoint(left.operation_id, right.operation_id));
    if (records.length === 0) {
      return deepFreeze({
        schema_version: 1,
        change_identity,
        status: "not_found",
        operations: []
      });
    }
    let aggregate: ArchiveReconcileResult["status"] = "prepared";
    const summaries = [];
    for (let record of records) {
      let status = record.status;
      let suggested_action: "none" | "resume" | "inspect" = "none";
      let reason_code = record.reason_code;
      const receipt = await port.loadReceipt(record.operation_id);
      const published = await port.inspectArchive(record.plan.archive_path);
      if (published !== undefined &&
          (published.operation_id !== record.operation_id ||
           published.change_identity !== record.change_identity ||
           (record.staged_manifest_hash !== undefined &&
            published.archive_manifest_hash !== record.staged_manifest_hash))) {
        status = "failed";
        reason_code = "ARCHIVE_IMMUTABLE_CONFLICT";
        suggested_action = "inspect";
        aggregate = "conflicted";
      } else if (receipt !== undefined) {
        if (published === undefined || receipt.archive_manifest_hash !== published.archive_manifest_hash) {
          status = "failed";
          reason_code = "ARCHIVE_IMMUTABLE_CONFLICT";
          suggested_action = "inspect";
          aggregate = "conflicted";
        } else if (aggregate !== "conflicted") {
          status = "locally_archived";
          aggregate = "locally_archived";
        }
      } else if (published !== undefined || status === "staging" || status === "validating" ||
          status === "published" || status === "receipt_written" || status === "recoverable" ||
          (new Date(record.lease_expires_at).getTime() <= clock().getTime() &&
           !await port.isOwnerActive(record.owner_id))) {
        status = "recoverable";
        suggested_action = "resume";
        if (aggregate !== "conflicted" && aggregate !== "locally_archived") aggregate = "recoverable";
        if (record.status !== "recoverable") {
          record = { ...record, status: "recoverable" };
          await port.saveOperation(record);
        }
      }
      summaries.push({
        operation_id: record.operation_id,
        status,
        suggested_action,
        ...(reason_code === undefined ? {} : { reason_code })
      });
    }
    return deepFreeze({ schema_version: 1, change_identity, status: aggregate, operations: summaries });
  }

  return { prepareArchive, finalizeLocalArchive, resumeArchive, reconcileArchive };
}
