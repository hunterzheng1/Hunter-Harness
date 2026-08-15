import {
  CODEBASE_MAP_V2_DOCUMENTS,
  inspectMap,
  planMapPublication,
  selectMappingExecutionPolicy,
  type MapHealth,
  type MapInspectionInput,
  type MapMode,
  type MapReceipt,
  type MappingExecutionPolicy
} from "../../codebase/map-v2/index.js";
import {
  compareCodepoint,
  deepFreeze,
  sortedUnique,
  stableHash,
  type ProviderApplicability,
  type SyncActionPlan,
  type SyncActionProvider,
  type SyncActionReceipt,
  type SyncApplyConfirmation,
  type SyncContext,
  type SyncFinding,
  type SyncRollbackReceipt,
  type SyncSha256,
  type SyncVerification
} from "../../sync-maintenance/index.js";
import {
  CodebaseMapSyncProviderError,
  type MapExecutionCompensationEvidence
} from "./errors.js";
import type {
  CodebaseMapSyncProviderInput,
  MapExecutionResult,
  MapRollbackRequest,
  MapRollbackResult,
  SuccessfulMapPublicationPlan
} from "./types.js";

const PROVIDER_ID = "codebase_map";
const FINDING_ID = "codebase_map:health";
const ACTION_ID = "codebase_map:refresh";
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const expectedWrites = [
  ...CODEBASE_MAP_V2_DOCUMENTS.map((name) => `.harness/codebase/map/${name}`),
  ".harness/codebase/map-summary.md",
  ".harness/codebase/map-manifest.json"
].sort();

interface PreparedAction {
  readonly action: SyncActionPlan;
  readonly health: MapHealth;
  readonly inspection_input: MapInspectionInput;
  readonly publication_plan: SuccessfulMapPublicationPlan;
  readonly execution_policy: MappingExecutionPolicy;
  readonly context: SyncContext;
}

interface AppliedRecord {
  readonly prepared: PreparedAction;
  readonly map_receipt: MapReceipt;
  readonly rollback_token: string;
  readonly sync_receipt: SyncActionReceipt;
}

interface CompensationFailureRecord {
  readonly sync_receipt: SyncActionReceipt;
  readonly verification: SyncVerification;
  readonly rollback_receipt: SyncRollbackReceipt;
}

interface SuccessfulCompensationRecord {
  readonly sync_receipt: SyncActionReceipt;
  readonly verification: SyncVerification;
}

type RollbackBoundaryOutcome =
  | { readonly status: "ok"; readonly result: MapRollbackResult }
  | { readonly status: "failed"; readonly error_name: string };

const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

function strictRfc3339(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = rfc3339.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 23 || offsetMinute > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (days[month - 1] ?? 0);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = sortedUnique(left);
  const normalizedRight = sortedUnique(right);
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function ownDataObject(value: unknown): value is Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
    });
  } catch {
    return false;
  }
}

function ownDataValue(value: unknown, key: string): unknown {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  try {
    const actual = Object.keys(value).sort(compareCodepoint);
    const expected = [...keys].sort(compareCodepoint);
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  } catch {
    return false;
  }
}

function ordinaryDenseArray(value: unknown): value is readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
    const expectedKeys = [
      ...Array.from({ length: value.length }, (_, index) => String(index)),
      "length"
    ];
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function ordinaryStringArray(value: unknown, canonical: boolean): readonly string[] | undefined {
  if (!ordinaryDenseArray(value)) return undefined;
  const snapshot: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index))?.value as unknown;
    if (!boundedText(item)) return undefined;
    snapshot.push(item);
  }
  if (new Set(snapshot).size !== snapshot.length) return undefined;
  if (canonical && snapshot.some((item, index) => index > 0 &&
      compareCodepoint(snapshot[index - 1] ?? "", item) >= 0)) return undefined;
  return snapshot;
}

function boundedText(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim();
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSyncSha256(value: string): value is SyncSha256 {
  return sha256Pattern.test(value);
}

function snapshotRollbackResult(value: unknown): MapRollbackResult | undefined {
  if (!ownDataObject(value)) return undefined;
  const rolledBack = ownDataValue(value, "rolled_back");
  const resultingManifestHash = ownDataValue(value, "resulting_manifest_hash");
  if (!exactKeys(value, resultingManifestHash === undefined
    ? ["rolled_back"]
    : ["rolled_back", "resulting_manifest_hash"]) || typeof rolledBack !== "boolean" ||
      (resultingManifestHash !== undefined &&
        (typeof resultingManifestHash !== "string" || !isSyncSha256(resultingManifestHash)))) {
    return undefined;
  }
  return deepFreeze({
    rolled_back: rolledBack,
    ...(resultingManifestHash === undefined
      ? {}
      : { resulting_manifest_hash: resultingManifestHash })
  });
}

function allVerified(verification: MapReceipt["verification"]): boolean {
  return verification.seven_documents_valid && verification.references_valid &&
    verification.sensitive_scan_passed && verification.atomic_publication_completed;
}

function validExecutionDetails(receipt: MapReceipt, policy: MappingExecutionPolicy): boolean {
  if (!ownDataObject(receipt.execution) || !exactKeys(receipt.execution, [
    "provider", "model", "duration_ms", "input_tokens", "output_tokens", "model_attempts",
    "escalated", "escalation_reasons"
  ]) || !boundedText(receipt.execution.provider) || !boundedText(receipt.execution.model) ||
      !nonnegativeSafeInteger(receipt.execution.duration_ms) ||
      receipt.execution.duration_ms > policy.timeout_ms ||
      !nonnegativeSafeInteger(receipt.execution.input_tokens) ||
      !nonnegativeSafeInteger(receipt.execution.output_tokens) ||
      receipt.execution.input_tokens + receipt.execution.output_tokens > policy.token_budget ||
      !Number.isSafeInteger(receipt.execution.model_attempts) || receipt.execution.model_attempts < 1 ||
      receipt.execution.model_attempts > policy.max_model_attempts ||
      typeof receipt.execution.escalated !== "boolean" ||
      ordinaryStringArray(receipt.execution.escalation_reasons, false) === undefined ||
      receipt.execution.escalation_reasons.some((reason) =>
        !policy.escalation_conditions.includes(reason as typeof policy.escalation_conditions[number])) ||
      receipt.execution.escalation_reasons.length !==
        new Set(receipt.execution.escalation_reasons).size ||
      receipt.execution.escalated !== (receipt.execution.escalation_reasons.length > 0)) return false;
  return true;
}

function snapshotExecutionPolicy(value: unknown): MappingExecutionPolicy | undefined {
  if (!ownDataObject(value) || !exactKeys(value, [
    "mode", "model_tier", "max_parallel_mappers", "max_model_attempts", "timeout_ms",
    "token_budget", "escalation_conditions"
  ])) return undefined;
  const escalationConditions = ordinaryStringArray(value.escalation_conditions, false);
  if (escalationConditions === undefined) return undefined;
  return {
    mode: value.mode as MappingExecutionPolicy["mode"],
    model_tier: value.model_tier as MappingExecutionPolicy["model_tier"],
    max_parallel_mappers: value.max_parallel_mappers as number,
    max_model_attempts: value.max_model_attempts as 2,
    timeout_ms: value.timeout_ms as number,
    token_budget: value.token_budget as number,
    escalation_conditions: escalationConditions as unknown as
      MappingExecutionPolicy["escalation_conditions"]
  };
}

function snapshotExecutionResult(value: unknown): MapExecutionResult | undefined {
  if (!ownDataObject(value) || !exactKeys(value, ["receipt", "modified_paths", "rollback_token"])) {
    return undefined;
  }
  const receiptValue = ownDataValue(value, "receipt");
  const rollbackToken = ownDataValue(value, "rollback_token");
  const modifiedPaths = ordinaryStringArray(ownDataValue(value, "modified_paths"), true);
  if (!ownDataObject(receiptValue) || typeof rollbackToken !== "string" ||
      modifiedPaths === undefined || !exactKeys(receiptValue, [
        "schema_version", "operation_id", "input_fingerprint", "previous_manifest_hash",
        "manifest_hash", "changed_documents", "preserved_documents", "execution_policy",
        "execution", "verification", "completed_at"
      ].filter((key) => key !== "previous_manifest_hash" ||
        ownDataValue(receiptValue, "previous_manifest_hash") !== undefined))) return undefined;
  const changedDocuments = ordinaryStringArray(ownDataValue(receiptValue, "changed_documents"), true);
  const preservedDocuments = ordinaryStringArray(ownDataValue(receiptValue, "preserved_documents"), true);
  const executionPolicy = snapshotExecutionPolicy(ownDataValue(receiptValue, "execution_policy"));
  const executionValue = ownDataValue(receiptValue, "execution");
  const verificationValue = ownDataValue(receiptValue, "verification");
  if (changedDocuments === undefined || preservedDocuments === undefined || executionPolicy === undefined ||
      !ownDataObject(executionValue) || !exactKeys(executionValue, [
        "provider", "model", "duration_ms", "input_tokens", "output_tokens", "model_attempts",
        "escalated", "escalation_reasons"
      ]) || !ownDataObject(verificationValue) || !validVerificationShape(verificationValue)) return undefined;
  const escalationReasons = ordinaryStringArray(ownDataValue(executionValue, "escalation_reasons"), false);
  if (escalationReasons === undefined) return undefined;
  const receipt: MapReceipt = {
    schema_version: ownDataValue(receiptValue, "schema_version") as 2,
    operation_id: ownDataValue(receiptValue, "operation_id") as string,
    input_fingerprint: ownDataValue(receiptValue, "input_fingerprint") as string,
    ...(ownDataValue(receiptValue, "previous_manifest_hash") === undefined ? {} : {
      previous_manifest_hash: ownDataValue(receiptValue, "previous_manifest_hash") as string
    }),
    manifest_hash: ownDataValue(receiptValue, "manifest_hash") as string,
    changed_documents: changedDocuments as MapReceipt["changed_documents"],
    preserved_documents: preservedDocuments as MapReceipt["preserved_documents"],
    execution_policy: executionPolicy,
    execution: {
      provider: ownDataValue(executionValue, "provider") as string,
      model: ownDataValue(executionValue, "model") as string,
      duration_ms: ownDataValue(executionValue, "duration_ms") as number,
      input_tokens: ownDataValue(executionValue, "input_tokens") as number,
      output_tokens: ownDataValue(executionValue, "output_tokens") as number,
      model_attempts: ownDataValue(executionValue, "model_attempts") as number,
      escalated: ownDataValue(executionValue, "escalated") as boolean,
      escalation_reasons: escalationReasons
    },
    verification: {
      seven_documents_valid: ownDataValue(verificationValue, "seven_documents_valid") as boolean,
      references_valid: ownDataValue(verificationValue, "references_valid") as boolean,
      sensitive_scan_passed: ownDataValue(verificationValue, "sensitive_scan_passed") as boolean,
      atomic_publication_completed: ownDataValue(verificationValue,
        "atomic_publication_completed") as boolean
    },
    completed_at: ownDataValue(receiptValue, "completed_at") as string
  };
  return deepFreeze({ receipt, modified_paths: modifiedPaths, rollback_token: rollbackToken });
}

function validVerificationShape(value: unknown): value is MapReceipt["verification"] {
  return ownDataObject(value) && exactKeys(value, [
    "seven_documents_valid", "references_valid", "sensitive_scan_passed",
    "atomic_publication_completed"
  ]) && Object.values(value).every((flag) => typeof flag === "boolean");
}

function validReadbackShape(value: unknown): value is {
  readonly operation_id: string;
  readonly input_fingerprint: string;
  readonly manifest_hash: string;
  readonly verification: MapReceipt["verification"];
} {
  return ownDataObject(value) && exactKeys(value, [
    "operation_id", "input_fingerprint", "manifest_hash", "verification"
  ]) && boundedText(value.operation_id) && typeof value.input_fingerprint === "string" &&
    isSyncSha256(value.input_fingerprint) && typeof value.manifest_hash === "string" &&
    isSyncSha256(value.manifest_hash) && validVerificationShape(value.verification);
}

function chooseMode(health: MapHealth): MapMode {
  if (health.suggested_actions.includes("run_full_refresh") || health.status === "missing" ||
      health.status === "conflicted") return "full";
  if (health.suggested_actions.includes("run_quick_refresh")) return "quick";
  return "incremental";
}

function primaryReason(health: MapHealth): string {
  if (health.reason_codes.includes("MAP_CODEGRAPH_UNAVAILABLE") &&
      health.reason_codes.every((reason) =>
        reason === "MAP_CURRENT" || reason === "MAP_CODEGRAPH_UNAVAILABLE")) {
    return "MAP_CODEGRAPH_UNAVAILABLE";
  }
  return health.reason_codes.find((reason) => reason !== "MAP_CODEGRAPH_UNAVAILABLE") ??
    health.reason_codes[0] ?? "MAP_CURRENT";
}

function degradationFinding(health: MapHealth): SyncFinding | undefined {
  if (!health.reason_codes.includes("MAP_CODEGRAPH_UNAVAILABLE") ||
      primaryReason(health) === "MAP_CODEGRAPH_UNAVAILABLE") return undefined;
  return deepFreeze({
    schema_version: 1,
    finding_id: "codebase_map:codegraph_degraded",
    provider_id: PROVIDER_ID,
    status: "ADVISORY",
    urgency: "optional",
    reason_code: "MAP_CODEGRAPH_UNAVAILABLE",
    display_title_zh: "Codebase Map 证据能力受限",
    display_message_zh: "CodeGraph 当前不可用；刷新会使用受限证据，不会递归扫描或宣称索引已是最新。",
    evidence: {
      source: "map_inspection_v2",
      input_hash: stableHash({
        input_fingerprint: health.input_fingerprint,
        degradation_reason: "MAP_CODEGRAPH_UNAVAILABLE"
      })
    }
  });
}

function findingPresentation(health: MapHealth): Pick<SyncFinding,
  "status" | "urgency" | "display_title_zh" | "display_message_zh"> {
  if (health.status === "conflicted") {
    return {
      status: "BLOCKED",
      urgency: "required",
      display_title_zh: "Codebase Map 存在冲突",
      display_message_zh: "地图身份或本地内容发生冲突，需要确认后才能刷新。"
    };
  }
  if (health.status === "missing" && health.reason_codes.includes("MAP_MANIFEST_MISSING")) {
    return {
      status: "WARN",
      urgency: "recommended",
      display_title_zh: "Codebase Map 尚未生成",
      display_message_zh: "已启用地图能力，建议生成当前项目的结构地图。"
    };
  }
  if (health.status === "refresh_required") {
    return {
      status: "WARN",
      urgency: "recommended",
      display_title_zh: "Codebase Map 需要更新",
      display_message_zh: "项目输入已经变化，建议仅刷新受影响的地图内容。"
    };
  }
  if (health.reason_codes.includes("MAP_CODEGRAPH_UNAVAILABLE")) {
    return {
      status: "ADVISORY",
      urgency: "optional",
      display_title_zh: "Codebase Map 证据能力受限",
      display_message_zh: "CodeGraph 当前不可用；不会递归扫描或宣称索引已是最新。"
    };
  }
  return {
    status: "OK",
    urgency: "none",
    display_title_zh: "Codebase Map 已是最新",
    display_message_zh: "当前输入与已发布地图一致，无需执行刷新。"
  };
}

function appliedKey(receipt: Pick<SyncActionReceipt, "input_hash" | "output_hash">): string {
  return `${receipt.input_hash}:${receipt.output_hash}`;
}

export function createCodebaseMapSyncProvider(
  input: CodebaseMapSyncProviderInput
): SyncActionProvider {
  const clock = input.clock ?? (() => new Date());
  const preparedByHash = new Map<string, PreparedAction>();
  const applied = new Map<string, AppliedRecord>();
  const compensationFailures = new Map<string, CompensationFailureRecord>();
  const compensated = new Set<string>();
  const successfulCompensations = new Map<string, SuccessfulCompensationRecord>();

  async function executeRollback(request: MapRollbackRequest): Promise<RollbackBoundaryOutcome> {
    try {
      const rawResult: unknown = await input.execution_port.rollback(request);
      const result = snapshotRollbackResult(rawResult);
      return result === undefined
        ? deepFreeze({ status: "failed", error_name: "invalid_rollback_result" })
        : deepFreeze({ status: "ok", result });
    } catch (error) {
      return deepFreeze({
        status: "failed",
        error_name: error instanceof Error ? error.name : "unknown_error"
      });
    }
  }

  function rememberCompensationFailure(
    receipt: SyncActionReceipt,
    evidence: MapExecutionCompensationEvidence,
    completedAt: string
  ): CompensationFailureRecord {
    const evidenceHash = stableHash({
      reason_code: "MAP_EXECUTION_COMPENSATION_FAILED",
      evidence
    });
    const record = deepFreeze({
      sync_receipt: receipt,
      verification: {
        schema_version: 1 as const,
        action_id: receipt.action_id,
        provider_id: PROVIDER_ID,
        status: "failed" as const,
        reason_code: "MAP_EXECUTION_COMPENSATION_FAILED",
        evidence_hash: evidenceHash,
        verified_at: completedAt
      },
      rollback_receipt: {
        schema_version: 1 as const,
        action_id: receipt.action_id,
        provider_id: PROVIDER_ID,
        status: "failed" as const,
        reason_code: "MAP_EXECUTION_COMPENSATION_FAILED",
        evidence_hash: evidenceHash,
        completed_at: completedAt
      }
    });
    compensationFailures.set(appliedKey(receipt), record);
    return record;
  }

  function inspectionInput(context: SyncContext): MapInspectionInput {
    const source = typeof input.inspection_input === "function"
      ? input.inspection_input(context)
      : input.inspection_input;
    if (source.project_identity !== context.project_identity ||
        (context.repository_identity !== undefined &&
          source.repository_identity !== context.repository_identity) ||
        (context.worktree_identity !== undefined &&
          source.worktree_identity !== context.worktree_identity)) {
      throw new CodebaseMapSyncProviderError("MAP_CONTEXT_IDENTITY_MISMATCH");
    }
    const isolated = structuredClone(source);
    return deepFreeze({
      ...isolated,
      project_identity: context.project_identity,
      repository_identity: context.repository_identity ?? isolated.repository_identity,
      ...(context.worktree_identity === undefined
        ? {}
        : { worktree_identity: context.worktree_identity }),
      ...(context.current_commit === undefined ? {} : { current_commit: context.current_commit }),
      dirty_paths: [...context.project_change_set.dirty_paths],
      untracked_paths: [...context.project_change_set.untracked_paths]
    });
  }

  function health(context: SyncContext): { health: MapHealth; inspection_input: MapInspectionInput } {
    const currentInput = inspectionInput(context);
    return { health: inspectMap(currentInput), inspection_input: currentInput };
  }

  function prepare(context: SyncContext, finding_ids: readonly string[]): PreparedAction | undefined {
    if (!finding_ids.includes(FINDING_ID)) return undefined;
    const current = health(context);
    if (current.health.status !== "missing" && current.health.status !== "refresh_required" &&
        current.health.status !== "conflicted") return undefined;
    const mode = chooseMode(current.health);
    const publicationInput = typeof input.publication_input === "function"
      ? input.publication_input(current.health, context)
      : input.publication_input;
    if (publicationInput.mode !== mode ||
        publicationInput.manifest_draft.input_fingerprint !== current.health.input_fingerprint ||
        publicationInput.manifest_draft.project_identity !== current.inspection_input.project_identity ||
        publicationInput.manifest_draft.repository_identity !== current.inspection_input.repository_identity ||
        publicationInput.manifest_draft.branch_name !== current.inspection_input.branch_name ||
        publicationInput.manifest_draft.worktree_identity !== current.inspection_input.worktree_identity ||
        publicationInput.manifest_draft.source_commit !== current.inspection_input.current_commit ||
        (mode === "incremental" && !sameStringSet(
          publicationInput.affected_documents,
          current.health.affected_documents
        )) ||
        (mode === "full" && !sameStringSet(
          publicationInput.affected_documents,
          CODEBASE_MAP_V2_DOCUMENTS
        )) ||
        publicationInput.previous_manifest_hash !== current.health.manifest_hash) {
      throw new CodebaseMapSyncProviderError("MAP_PUBLICATION_PLAN_INVALID");
    }
    const publicationPlan = planMapPublication(publicationInput);
    if (!publicationPlan.ok || !sameStringSet(
      publicationPlan.operations.flatMap((operation) =>
        operation.operation === "stage_write" ? [operation.path] : []),
      expectedWrites
    )) throw new CodebaseMapSyncProviderError("MAP_PUBLICATION_PLAN_INVALID");
    const executionPolicy = selectMappingExecutionPolicy({
      mode,
      affected_topic_count: current.health.affected_documents.length
    });
    const invalidationHash = stableHash({
      context_hash: context.context_hash,
      map_input_fingerprint: current.health.input_fingerprint,
      previous_manifest_hash: current.health.manifest_hash ?? null,
      publication_plan_hash: publicationPlan.plan_hash,
      execution_policy: executionPolicy
    });
    const action: SyncActionPlan = deepFreeze({
      schema_version: 1,
      action_id: ACTION_ID,
      provider_id: PROVIDER_ID,
      finding_ids: [FINDING_ID],
      depends_on: [],
      conflicts_with: [],
      invalidates_providers: [PROVIDER_ID],
      expected_writes: expectedWrites,
      network_access: false,
      model_access: true,
      risk: current.health.status === "conflicted" ? "high" : "medium",
      rollback_strategy: "automatic",
      invalidation_hash: invalidationHash,
      estimated_duration_ms: executionPolicy.timeout_ms
    });
    const prepared = deepFreeze({
      action,
      health: current.health,
      inspection_input: current.inspection_input,
      publication_plan: publicationPlan,
      execution_policy: executionPolicy,
      context
    });
    preparedByHash.set(invalidationHash, prepared);
    return prepared;
  }

  function validExecutionResult(prepared: PreparedAction, result: MapExecutionResult): boolean {
    const receipt = result.receipt;
    const manifestWrite = prepared.publication_plan.operations.find((operation) =>
      operation.operation === "stage_write" &&
      operation.path === ".harness/codebase/map-manifest.json"
    );
    return receipt.schema_version === 2 && boundedText(receipt.operation_id) &&
      receipt.input_fingerprint === prepared.health.input_fingerprint &&
      receipt.previous_manifest_hash === prepared.health.manifest_hash &&
      manifestWrite?.operation === "stage_write" && receipt.manifest_hash === manifestWrite.content_hash &&
      isSyncSha256(receipt.manifest_hash) &&
      sameStringSet(receipt.changed_documents, prepared.publication_plan.changed_documents) &&
      sameStringSet(receipt.preserved_documents, prepared.publication_plan.preserved_documents) &&
      receipt.manifest_hash !== prepared.action.invalidation_hash &&
      stableHash(receipt.execution_policy) === stableHash(prepared.execution_policy) &&
      validExecutionDetails(receipt, prepared.execution_policy) &&
      allVerified(receipt.verification) &&
      strictRfc3339(receipt.completed_at) &&
      stableHash(result.modified_paths) === stableHash(expectedWrites) && boundedText(result.rollback_token);
  }

  async function compensateInvalidExecution(
    prepared: PreparedAction,
    result: unknown,
    started: number
  ): Promise<SyncActionReceipt> {
    const rawReceipt = ownDataValue(result, "receipt");
    const operationId = ownDataValue(rawReceipt, "operation_id");
    const rollbackToken = ownDataValue(result, "rollback_token");
    const manifestWrite = prepared.publication_plan.operations.find((operation) =>
      operation.operation === "stage_write" &&
      operation.path === ".harness/codebase/map-manifest.json"
    );
    const expectedManifestHash: SyncSha256 = manifestWrite?.operation === "stage_write" &&
      isSyncSha256(manifestWrite.content_hash)
      ? manifestWrite.content_hash
      : prepared.action.invalidation_hash;
    const evidenceBase = {
      operation_id: typeof operationId === "string" ? operationId : "unknown",
      expected_manifest_hash: expectedManifestHash
    };
    let compensationEvidence: MapExecutionCompensationEvidence;
    const rollbackOutcome = await executeRollback(deepFreeze({
        schema_version: 1,
        operation_id: boundedText(operationId) ? operationId : "unknown",
        rollback_token: rollbackToken !== null &&
          ["string", "number", "boolean", "bigint"].includes(typeof rollbackToken)
          ? String(rollbackToken)
          : "unknown",
        expected_manifest_hash: expectedManifestHash,
        ...(prepared.health.manifest_hash === undefined
          ? {}
          : { expected_previous_manifest_hash: prepared.health.manifest_hash })
      }));
    if (rollbackOutcome.status === "ok") {
      const compensated = rollbackOutcome.result.rolled_back === true &&
        rollbackOutcome.result.resulting_manifest_hash === prepared.health.manifest_hash;
      if (!compensated) {
        compensationEvidence = {
          ...evidenceBase,
          rollback_result: rollbackOutcome.result
        };
      } else {
        throw new CodebaseMapSyncProviderError("MAP_EXECUTION_RECEIPT_INVALID", evidenceBase);
      }
    } else {
      compensationEvidence = {
        ...evidenceBase,
        compensation_error_name: rollbackOutcome.error_name
      };
    }
    const completedAt = clock().toISOString();
    const failureHash = stableHash({ reason_code: "MAP_EXECUTION_COMPENSATION_FAILED",
      evidence: compensationEvidence });
    const receipt: SyncActionReceipt = deepFreeze({
      schema_version: 1,
      action_id: prepared.action.action_id,
      provider_id: PROVIDER_ID,
      input_hash: prepared.action.invalidation_hash,
      output_hash: expectedManifestHash,
      evidence_sources: [
        "map_publication_plan",
        "map_execution_receipt",
        "MAP_EXECUTION_COMPENSATION_FAILED"
      ],
      wrote: true,
      modified_paths: expectedWrites,
      rollback: {
        strategy: "automatic",
        available: true,
        rollback_token: failureHash
      },
      auto_fixed: true,
      duration_ms: Math.max(0, clock().getTime() - started),
      completed_at: completedAt
    });
    rememberCompensationFailure(receipt, compensationEvidence, completedAt);
    return receipt;
  }

  async function compensateAppliedRecord(
    key: string,
    record: AppliedRecord
  ): Promise<boolean> {
    const rollbackOutcome = await executeRollback(deepFreeze({
        schema_version: 1,
        operation_id: record.map_receipt.operation_id,
        rollback_token: record.rollback_token,
        expected_manifest_hash: record.map_receipt.manifest_hash,
        ...(record.map_receipt.previous_manifest_hash === undefined
          ? {}
          : { expected_previous_manifest_hash: record.map_receipt.previous_manifest_hash })
      }));
    if (rollbackOutcome.status === "failed") {
      rememberCompensationFailure(record.sync_receipt, {
        operation_id: record.map_receipt.operation_id,
        expected_manifest_hash: record.map_receipt.manifest_hash,
        compensation_error_name: rollbackOutcome.error_name
      }, clock().toISOString());
      return false;
    }
    if (!rollbackOutcome.result.rolled_back ||
        rollbackOutcome.result.resulting_manifest_hash !== record.map_receipt.previous_manifest_hash) {
      rememberCompensationFailure(record.sync_receipt, {
        operation_id: record.map_receipt.operation_id,
        expected_manifest_hash: record.map_receipt.manifest_hash,
        rollback_result: rollbackOutcome.result
      }, clock().toISOString());
      return false;
    }
    compensated.add(key);
    return true;
  }

  return Object.freeze({
    provider_id: PROVIDER_ID,

    async applicable(context: SyncContext): Promise<ProviderApplicability> {
      const result = health(context).health;
      return deepFreeze(result.applicability === "not_applicable"
        ? { applicability: "not_applicable", reason_code: "MAP_NOT_ADOPTED" }
        : { applicability: "applicable", reason_code: "MAP_APPLICABLE" });
    },

    async inspect(context: SyncContext): Promise<readonly SyncFinding[]> {
      const result = health(context).health;
      if (result.applicability === "not_applicable") return deepFreeze([]);
      const presentation = findingPresentation(result);
      const primary: SyncFinding = {
        schema_version: 1,
        finding_id: FINDING_ID,
        provider_id: PROVIDER_ID,
        ...presentation,
        reason_code: primaryReason(result),
        evidence: {
          source: "map_inspection_v2",
          input_hash: stableHash({
            input_fingerprint: result.input_fingerprint,
            reason_codes: result.reason_codes
          }),
          ...(result.manifest_hash === undefined || !isSyncSha256(result.manifest_hash)
            ? {}
            : { observed_hash: result.manifest_hash })
        }
      };
      const degradation = degradationFinding(result);
      return deepFreeze(degradation === undefined ? [primary] : [primary, degradation]);
    },

    async plan(context: SyncContext, finding_ids: readonly string[]): Promise<readonly SyncActionPlan[]> {
      const prepared = prepare(context, finding_ids);
      return prepared === undefined ? deepFreeze([]) : deepFreeze([prepared.action]);
    },

    async apply(
      action_plan: SyncActionPlan,
      confirmation: SyncApplyConfirmation
    ): Promise<SyncActionReceipt> {
      const prepared = preparedByHash.get(action_plan.invalidation_hash);
      let latest: PreparedAction | undefined;
      try {
        latest = prepared === undefined ? undefined : prepare(prepared.context, [FINDING_ID]);
      } catch {
        latest = undefined;
      }
      if (prepared === undefined || action_plan.action_id !== ACTION_ID ||
          stableHash(action_plan) !== stableHash(prepared.action) || !confirmation.allow_writes ||
          !confirmation.allow_model || latest === undefined ||
          stableHash(latest.action) !== stableHash(prepared.action)) {
        throw new CodebaseMapSyncProviderError("MAP_ACTION_STALE");
      }
      const started = clock().getTime();
      const rawResult: unknown = await input.execution_port.execute(deepFreeze({
        schema_version: 1,
        action_id: action_plan.action_id,
        expected_input_fingerprint: prepared.health.input_fingerprint,
        ...(prepared.health.manifest_hash === undefined
          ? {}
          : { expected_previous_manifest_hash: prepared.health.manifest_hash }),
        publication_plan: prepared.publication_plan,
        execution_policy: prepared.execution_policy
      }));
      const result = snapshotExecutionResult(rawResult);
      if (result === undefined || !validExecutionResult(prepared, result)) {
        return compensateInvalidExecution(prepared, rawResult, started);
      }
      if (!isSyncSha256(result.receipt.manifest_hash)) {
        throw new CodebaseMapSyncProviderError("MAP_EXECUTION_RECEIPT_INVALID");
      }
      const receipt: SyncActionReceipt = deepFreeze({
        schema_version: 1,
        action_id: action_plan.action_id,
        provider_id: PROVIDER_ID,
        input_hash: action_plan.invalidation_hash,
        output_hash: result.receipt.manifest_hash,
        evidence_sources: ["map_publication_plan", "map_execution_receipt"],
        wrote: true,
        modified_paths: sortedUnique(result.modified_paths),
        rollback: {
          strategy: "automatic",
          available: true,
          rollback_token: result.rollback_token
        },
        auto_fixed: true,
        duration_ms: Math.max(0, clock().getTime() - started),
        completed_at: result.receipt.completed_at
      });
      applied.set(appliedKey(receipt), deepFreeze({
        prepared,
        map_receipt: result.receipt,
        rollback_token: result.rollback_token,
        sync_receipt: receipt
      }));
      return receipt;
    },

    async verify(receipt: SyncActionReceipt): Promise<SyncVerification> {
      const key = appliedKey(receipt);
      const compensationFailure = compensationFailures.get(key);
      if (compensationFailure !== undefined &&
          stableHash(receipt) === stableHash(compensationFailure.sync_receipt)) {
        return compensationFailure.verification;
      }
      const successfulCompensation = successfulCompensations.get(key);
      if (successfulCompensation !== undefined &&
          stableHash(receipt) === stableHash(successfulCompensation.sync_receipt)) {
        return successfulCompensation.verification;
      }
      const record = applied.get(key);
      if (record === undefined || stableHash(receipt) !== stableHash(record.sync_receipt)) {
        throw new CodebaseMapSyncProviderError("MAP_EXECUTION_RECEIPT_NOT_FOUND");
      }
      let readback;
      let readbackErrorName: string | undefined;
      try {
        readback = await input.execution_port.readback(record.map_receipt.operation_id);
      } catch (error) {
        readbackErrorName = error instanceof Error ? error.name : "unknown_error";
      }
      const verified = validReadbackShape(readback) &&
        readback.operation_id === record.map_receipt.operation_id &&
        readback.input_fingerprint === record.map_receipt.input_fingerprint &&
        readback.manifest_hash === record.map_receipt.manifest_hash &&
        receipt.output_hash === readback.manifest_hash &&
        validVerificationShape(readback.verification) && allVerified(readback.verification);
      let didCompensate = false;
      if (!verified) {
        didCompensate = await compensateAppliedRecord(key, record);
        if (!didCompensate) {
          const failure = compensationFailures.get(key);
          if (failure !== undefined) return failure.verification;
        }
      }
      const readbackEvidence = validReadbackShape(readback)
        ? {
          operation_id: readback.operation_id,
          input_fingerprint: readback.input_fingerprint,
          manifest_hash: readback.manifest_hash,
          verification: readback.verification
        }
        : { invalid_readback: true };
      const verification: SyncVerification = deepFreeze({
        schema_version: 1,
        action_id: receipt.action_id,
        provider_id: PROVIDER_ID,
        status: verified ? "verified" : "failed",
        reason_code: verified ? "MAP_RECEIPT_VERIFIED" : "MAP_RECEIPT_MISMATCH",
        evidence_hash: stableHash({
          receipt,
          readback: readbackEvidence,
          readback_error_name: readbackErrorName
        }),
        verified_at: clock().toISOString()
      });
      if (didCompensate) {
        successfulCompensations.set(key, deepFreeze({ sync_receipt: receipt, verification }));
      }
      return verification;
    },

    async rollback(
      action_plan: SyncActionPlan,
      receipt: SyncActionReceipt
    ): Promise<SyncRollbackReceipt> {
      const key = appliedKey(receipt);
      const compensationFailure = compensationFailures.get(key);
      if (compensationFailure !== undefined &&
          action_plan.invalidation_hash === receipt.input_hash &&
          stableHash(receipt) === stableHash(compensationFailure.sync_receipt)) {
        return compensationFailure.rollback_receipt;
      }
      const record = applied.get(key);
      if (record === undefined || action_plan.invalidation_hash !== receipt.input_hash ||
          receipt.rollback.rollback_token !== record.rollback_token ||
          stableHash(receipt) !== stableHash(record.sync_receipt)) {
        throw new CodebaseMapSyncProviderError("MAP_EXECUTION_RECEIPT_NOT_FOUND");
      }
      if (compensated.has(key)) {
        compensated.delete(key);
        successfulCompensations.delete(key);
        applied.delete(key);
        return deepFreeze({
          schema_version: 1,
          action_id: action_plan.action_id,
          provider_id: PROVIDER_ID,
          status: "rolled_back",
          reason_code: "MAP_ROLLBACK_COMPLETED",
          evidence_hash: stableHash({ receipt, already_compensated: true }),
          completed_at: clock().toISOString()
        });
      }
      const rollbackOutcome = await executeRollback(deepFreeze({
        schema_version: 1,
        operation_id: record.map_receipt.operation_id,
        rollback_token: record.rollback_token,
        expected_manifest_hash: record.map_receipt.manifest_hash,
        ...(record.map_receipt.previous_manifest_hash === undefined
          ? {}
          : { expected_previous_manifest_hash: record.map_receipt.previous_manifest_hash })
      }));
      const rollback = rollbackOutcome.status === "ok" ? rollbackOutcome.result : undefined;
      const rolledBack = rollback !== undefined && rollback.rolled_back &&
        rollback.resulting_manifest_hash === record.map_receipt.previous_manifest_hash;
      if (rolledBack) applied.delete(appliedKey(receipt));
      return deepFreeze({
        schema_version: 1,
        action_id: action_plan.action_id,
        provider_id: PROVIDER_ID,
        status: rolledBack ? "rolled_back" : "failed",
        reason_code: rolledBack ? "MAP_ROLLBACK_COMPLETED" : "MAP_ROLLBACK_FAILED",
        evidence_hash: stableHash({
          receipt,
          ...(rollbackOutcome.status === "ok"
            ? { rollback: rollbackOutcome.result }
            : { rollback_error_name: rollbackOutcome.error_name })
        }),
        completed_at: clock().toISOString()
      });
    }
  });
}
