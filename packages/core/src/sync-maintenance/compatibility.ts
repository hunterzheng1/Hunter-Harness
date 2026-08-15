import { compareCodepoint, deepFreeze, sortedUnique, stableHash } from "./stable.js";
import type {
  ProviderApplicabilityState,
  SyncActionPlan,
  SyncFinding,
  SyncHealthStatus,
  SyncMaintenanceReadResult,
  SyncPlan,
  SyncProviderResult,
  SyncSha256,
  SyncUrgency
} from "./types.js";

const sha = /^sha256:(?!0{64}$)[a-f0-9]{64}$/u;
const planId = /^sync_plan:[a-f0-9]{64}$/u;
const identifier = /^[a-z0-9][a-z0-9._:-]*$/u;
const statuses = new Set<SyncHealthStatus>(["OK", "ADVISORY", "WARN", "FAIL", "BLOCKED", "UNKNOWN"]);
const urgencies = new Set<SyncUrgency>(["none", "optional", "recommended", "required"]);
const applicabilityStates = new Set<ProviderApplicabilityState>([
  "applicable", "not_applicable", "unavailable"
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[],
  optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && keys.every((key) => allowed.has(key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value === value.trim();
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => text(item));
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function syncHash(value: unknown): value is SyncSha256 {
  return typeof value === "string" && sha.test(value);
}

function finding(input: unknown): input is SyncFinding {
  if (!record(input) || !exactKeys(input, [
    "schema_version", "finding_id", "provider_id", "status", "urgency", "reason_code",
    "display_title_zh", "display_message_zh", "evidence"
  ]) || input.schema_version !== 1 || !text(input.finding_id) || !identifier.test(input.finding_id) ||
      !text(input.provider_id) || !identifier.test(input.provider_id) ||
      !statuses.has(input.status as SyncHealthStatus) || !urgencies.has(input.urgency as SyncUrgency) ||
      !text(input.reason_code) || !identifier.test(input.reason_code.toLowerCase()) ||
      !text(input.display_title_zh) || !text(input.display_message_zh) || !record(input.evidence) ||
      !exactKeys(input.evidence, ["source", "input_hash"], ["observed_hash"]) ||
      !text(input.evidence.source) || !identifier.test(input.evidence.source) ||
      !syncHash(input.evidence.input_hash) ||
      (input.evidence.observed_hash !== undefined && !syncHash(input.evidence.observed_hash))) return false;
  return true;
}

function action(input: unknown): input is SyncActionPlan {
  if (!record(input) || !exactKeys(input, [
    "schema_version", "action_id", "provider_id", "finding_ids", "depends_on",
    "conflicts_with", "invalidates_providers", "expected_writes", "network_access",
    "model_access", "risk", "rollback_strategy", "invalidation_hash", "estimated_duration_ms"
  ]) || input.schema_version !== 1 || !text(input.action_id) || !identifier.test(input.action_id) ||
      !text(input.provider_id) || !identifier.test(input.provider_id) ||
      !stringArray(input.finding_ids) || input.finding_ids.length === 0 ||
      !input.finding_ids.every((item) => identifier.test(item)) || !stringArray(input.depends_on) ||
      !input.depends_on.every((item) => identifier.test(item)) || !stringArray(input.conflicts_with) ||
      !input.conflicts_with.every((item) => identifier.test(item)) ||
      !stringArray(input.invalidates_providers) ||
      !input.invalidates_providers.every((item) => identifier.test(item)) ||
      !Array.isArray(input.expected_writes) || !input.expected_writes.every((path) =>
        typeof path === "string" && path !== "" && !path.includes("\\") && !path.startsWith("/") &&
        !/^[a-z]:/iu.test(path) && !path.split("/").some((part) =>
          part === "" || part === "." || part === ".." || part.startsWith(".env") ||
          part === "credentials.local" || part.startsWith("credentials.local."))) ||
      typeof input.network_access !== "boolean" || typeof input.model_access !== "boolean" ||
      !(["low", "medium", "high"] as const).includes(input.risk as "low") ||
      !(["none", "automatic", "manual"] as const).includes(input.rollback_strategy as "none") ||
      !syncHash(input.invalidation_hash) || !Number.isSafeInteger(input.estimated_duration_ms) ||
      (input.estimated_duration_ms as number) < 0) return false;
  const uniqueFields = [input.finding_ids, input.depends_on, input.conflicts_with,
    input.invalidates_providers, input.expected_writes] as readonly string[][];
  return uniqueFields.every((items) => items.length === new Set(items).size);
}

function providerResult(input: unknown): input is SyncProviderResult {
  if (!record(input) || !exactKeys(input, [
    "provider_id", "applicability", "status", "urgency", "reason_code", "findings", "duration_ms"
  ], ["timeout_type", "degradation_reason"]) || !text(input.provider_id) ||
      !identifier.test(input.provider_id) ||
      !applicabilityStates.has(input.applicability as ProviderApplicabilityState) ||
      !statuses.has(input.status as SyncHealthStatus) || !urgencies.has(input.urgency as SyncUrgency) ||
      !text(input.reason_code) || !identifier.test(input.reason_code.toLowerCase()) ||
      !Array.isArray(input.findings) || !input.findings.every(finding) ||
      input.findings.some((item) => item.provider_id !== input.provider_id) ||
      !Number.isSafeInteger(input.duration_ms) || (input.duration_ms as number) < 0 ||
      (input.timeout_type !== undefined && input.timeout_type !== "provider_budget") ||
      (input.degradation_reason !== undefined && !text(input.degradation_reason))) return false;
  if (input.applicability !== "applicable") {
    return input.status === "UNKNOWN" && input.urgency === "none" && input.findings.length === 0;
  }
  if (input.findings.length === 0) return input.status === "OK" && input.urgency === "none";
  return input.findings.some((item) => item.status === input.status) &&
    input.findings.some((item) => item.urgency === input.urgency);
}

function plan(input: unknown): input is SyncPlan {
  if (!record(input) || !exactKeys(input, [
    "schema_version", "plan_id", "context_hash", "input_hash", "provider_results", "findings",
    "actions", "expected_writes", "preview_hash", "created_at", "expires_at", "summary"
  ]) || input.schema_version !== 1 || typeof input.plan_id !== "string" || !planId.test(input.plan_id) ||
      !syncHash(input.context_hash) || !syncHash(input.input_hash) ||
      !Array.isArray(input.provider_results) || !input.provider_results.every(providerResult) ||
      !Array.isArray(input.findings) || !input.findings.every(finding) ||
      !Array.isArray(input.actions) || !input.actions.every(action) ||
      !stringArray(input.expected_writes) || !syncHash(input.preview_hash) ||
      !timestamp(input.created_at) || !timestamp(input.expires_at) ||
      new Date(input.expires_at).getTime() <= new Date(input.created_at).getTime() || !record(input.summary)) {
    return false;
  }
  const providerIds = input.provider_results.map((item) => item.provider_id);
  if (providerIds.join("\0") !== sortedUnique(providerIds).join("\0")) return false;
  const flatFindings = input.provider_results.flatMap((item) => item.findings)
    .sort((left, right) => compareCodepoint(left.finding_id, right.finding_id));
  if (stableHash(flatFindings) !== stableHash(input.findings)) return false;
  const findingsById = new Map(input.findings.map((item) => [item.finding_id, item]));
  const actionIds = new Set(input.actions.map((item) => item.action_id));
  if (actionIds.size !== input.actions.length || input.actions.some((item) =>
    !providerIds.includes(item.provider_id) || item.finding_ids.some((findingId) =>
      findingsById.get(findingId)?.provider_id !== item.provider_id) ||
    item.depends_on.includes(item.action_id) || item.depends_on.some((dependency) => !actionIds.has(dependency)) ||
    item.conflicts_with.includes(item.action_id))) return false;
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(input.actions.map((item) => [item.action_id, item]));
  const visit = (actionId: string): boolean => {
    if (visiting.has(actionId)) return false;
    if (visited.has(actionId)) return true;
    visiting.add(actionId);
    for (const dependency of byId.get(actionId)?.depends_on ?? []) if (!visit(dependency)) return false;
    visiting.delete(actionId);
    visited.add(actionId);
    return true;
  };
  if (input.actions.some((item) => !visit(item.action_id))) return false;
  const expectedWrites = sortedUnique(input.actions.flatMap((item) => item.expected_writes));
  if (stableHash(expectedWrites) !== stableHash(input.expected_writes)) return false;
  const expectedInputHash = stableHash({ context_hash: input.context_hash, provider_ids: providerIds });
  const expectedPreviewHash = stableHash({
    input_hash: expectedInputHash,
    provider_results: input.provider_results,
    actions: input.actions
  });
  const expectedPlanId = `sync_plan:${stableHash({
    preview_hash: expectedPreviewHash, created_at: input.created_at
  }).slice("sha256:".length)}`;
  const statusCounts: Partial<Record<SyncHealthStatus, number>> = {};
  const urgencyCounts: Partial<Record<SyncUrgency, number>> = {};
  for (const result of input.provider_results) {
    statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1;
    urgencyCounts[result.urgency] = (urgencyCounts[result.urgency] ?? 0) + 1;
  }
  const expectedSummary = {
    schema_version: 1,
    provider_count: input.provider_results.length,
    not_applicable_count: input.provider_results.filter((item) =>
      item.applicability === "not_applicable").length,
    unavailable_count: input.provider_results.filter((item) =>
      item.applicability === "unavailable").length,
    status_counts: statusCounts,
    urgency_counts: urgencyCounts
  };
  return input.input_hash === expectedInputHash && input.preview_hash === expectedPreviewHash &&
    input.plan_id === expectedPlanId && stableHash(input.summary) === stableHash(expectedSummary);
}

function legacyStatus(input: unknown): SyncHealthStatus | undefined {
  if (input === "green" || input === "OK") return "OK";
  if (input === "yellow" || input === "WARN") return "WARN";
  if (input === "red" || input === "FAIL") return "FAIL";
  if (input === "ADVISORY" || input === "BLOCKED" || input === "UNKNOWN") return input;
  return undefined;
}

export function normalizeSyncMaintenanceRecord(input: unknown): SyncMaintenanceReadResult {
  if (!record(input)) return { ok: false, reason_code: "SYNC_RECORD_INVALID" };
  if (input.schema_version === 1) {
    if (!plan(input)) return { ok: false, reason_code: "SYNC_RECORD_INVALID" };
    return deepFreeze({ ok: true, source_schema_version: 1, plan: input });
  }
  if (input.schemaVersion === 0) {
    if (!exactKeys(input, [
      "schemaVersion", "status", "inputHash", "outputHash", "evidence", "autoFixed",
      "reportPath", "reportSha256"
    ]) || legacyStatus(input.status) === undefined ||
        (input.inputHash !== null && !syncHash(input.inputHash)) ||
        (input.outputHash !== null && !syncHash(input.outputHash)) ||
        typeof input.autoFixed !== "boolean" || input.reportPath !== null || input.reportSha256 !== null) {
      return { ok: false, reason_code: "SYNC_RECORD_INVALID" };
    }
    return deepFreeze({
      ok: true,
      source_schema_version: 0,
      readiness: "legacy_read_only",
      legacy: {
        status: legacyStatus(input.status) as SyncHealthStatus,
        input_hash: input.inputHash,
        report_path: null,
        report_sha256: null
      },
      reason_codes: [
        "LEGACY_PLAN_ID_UNKNOWN",
        "LEGACY_PREVIEW_HASH_UNKNOWN",
        "LEGACY_RECEIPTS_UNTRUSTED"
      ]
    });
  }
  return "schema_version" in input || "schemaVersion" in input
    ? { ok: false, reason_code: "SYNC_RECORD_VERSION_UNSUPPORTED" }
    : { ok: false, reason_code: "SYNC_RECORD_INVALID" };
}
