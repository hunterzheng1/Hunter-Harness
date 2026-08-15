import { SyncMaintenanceError } from "./errors.js";
import {
  compareCodepoint,
  createSyncContext,
  deepFreeze,
  safeRelativePath,
  sortedUnique,
  stableHash,
  syncContextPayload
} from "./stable.js";
import type {
  ProviderApplicability,
  SyncActionPlan,
  SyncActionProvider,
  SyncActionReceipt,
  SyncApplyFailureEvidence,
  SyncApplyConfirmation,
  SyncApplyResult,
  SyncContext,
  SyncFinding,
  SyncHealthStatus,
  SyncMaintenanceModule,
  SyncPlan,
  SyncPlanSummary,
  SyncProviderResult,
  SyncProviderRegistry,
  SyncRollbackReceipt,
  SyncUrgency,
  SyncVerification
} from "./types.js";

const sha = /^sha256:(?!0{64}$)[a-f0-9]{64}$/u;
const id = /^[a-z0-9][a-z0-9._:-]*$/u;
const healthStatuses = new Set<SyncHealthStatus>([
  "OK", "ADVISORY", "WARN", "FAIL", "BLOCKED", "UNKNOWN"
]);
const urgencies = new Set<SyncUrgency>(["none", "optional", "recommended", "required"]);

function exactKeys(value: object, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && keys.every((key) => allowed.has(key));
}

function validFinding(value: SyncFinding, providerId: string): boolean {
  return exactKeys(value, [
    "schema_version", "finding_id", "provider_id", "status", "urgency", "reason_code",
    "display_title_zh", "display_message_zh", "evidence"
  ]) && exactKeys(value.evidence, ["source", "input_hash"], ["observed_hash"]) &&
    value.schema_version === 1 && value.provider_id === providerId && id.test(value.finding_id) &&
    healthStatuses.has(value.status) && urgencies.has(value.urgency) && id.test(value.reason_code.toLowerCase()) &&
    value.display_title_zh.trim() !== "" && value.display_message_zh.trim() !== "" &&
    id.test(value.evidence.source) && sha.test(value.evidence.input_hash) &&
    (value.evidence.observed_hash === undefined || sha.test(value.evidence.observed_hash));
}

function validActionDeclaration(action: SyncActionPlan, providerId: string): boolean {
  return exactKeys(action, [
    "schema_version", "action_id", "provider_id", "finding_ids", "depends_on",
    "conflicts_with", "invalidates_providers", "expected_writes", "network_access",
    "model_access", "risk", "rollback_strategy", "invalidation_hash", "estimated_duration_ms"
  ]) && action.schema_version === 1 && action.provider_id === providerId && id.test(action.action_id) &&
    action.finding_ids.length > 0 && action.finding_ids.every((findingId) => id.test(findingId)) &&
    action.expected_writes.every(safeRelativePath) &&
    [action.finding_ids, action.depends_on, action.conflicts_with, action.invalidates_providers,
      action.expected_writes].every((values) => values.length === new Set(values).size) &&
    action.depends_on.every((actionId) => id.test(actionId)) &&
    action.conflicts_with.every((actionId) => id.test(actionId)) &&
    action.invalidates_providers.every((invalidated) => id.test(invalidated)) &&
    typeof action.network_access === "boolean" && typeof action.model_access === "boolean" &&
    (["low", "medium", "high"] as const).includes(action.risk) &&
    (["none", "automatic", "manual"] as const).includes(action.rollback_strategy) &&
    sha.test(action.invalidation_hash) && Number.isSafeInteger(action.estimated_duration_ms) &&
    action.estimated_duration_ms >= 0;
}

function validContext(context: SyncContext): boolean {
  try {
    const { context_hash: contextHash, ...contextInput } = context;
    return context.schema_version === 1 && sha.test(context.context_hash) &&
      createSyncContext(contextInput).context_hash === contextHash &&
      context.context_hash === stableHash(syncContextPayload(context));
  } catch {
    return false;
  }
}

function statusRank(status: SyncHealthStatus): number {
  return ["OK", "ADVISORY", "UNKNOWN", "WARN", "FAIL", "BLOCKED"].indexOf(status);
}

function urgencyRank(urgency: SyncUrgency): number {
  return ["none", "optional", "recommended", "required"].indexOf(urgency);
}

function aggregateResult(provider_id: string, applicability: ProviderApplicability,
  findings: readonly SyncFinding[], duration_ms: number): SyncProviderResult {
  const status = findings.reduce<SyncHealthStatus>((current, item) =>
    statusRank(item.status) > statusRank(current) ? item.status : current, "OK");
  const urgency = findings.reduce<SyncUrgency>((current, item) =>
    urgencyRank(item.urgency) > urgencyRank(current) ? item.urgency : current, "none");
  const primary = [...findings].sort((left, right) =>
    statusRank(right.status) - statusRank(left.status) ||
      compareCodepoint(left.finding_id, right.finding_id)
  )[0];
  return {
    provider_id,
    applicability: applicability.applicability,
    status: primary?.status ?? status,
    urgency,
    reason_code: primary?.reason_code ?? applicability.reason_code,
    findings,
    duration_ms
  };
}

function summary(results: readonly SyncProviderResult[]): SyncPlanSummary {
  const status_counts: Partial<Record<SyncHealthStatus, number>> = {};
  const urgency_counts: Partial<Record<SyncUrgency, number>> = {};
  for (const result of results) {
    status_counts[result.status] = (status_counts[result.status] ?? 0) + 1;
    urgency_counts[result.urgency] = (urgency_counts[result.urgency] ?? 0) + 1;
  }
  return {
    schema_version: 1,
    provider_count: results.length,
    not_applicable_count: results.filter((item) => item.applicability === "not_applicable").length,
    unavailable_count: results.filter((item) => item.applicability === "unavailable").length,
    status_counts,
    urgency_counts
  };
}

async function boundedMap<T, R>(items: readonly T[], limit: number,
  work: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) output[index] = await work(item);
    }
  }));
  return output;
}

function assertActionGraph(actions: readonly SyncActionPlan[]): void {
  const byId = new Map(actions.map((action) => [action.action_id, action]));
  if (byId.size !== actions.length) throw new SyncMaintenanceError("SYNC_PLAN_INVALID");
  for (const action of actions) {
    if (!id.test(action.action_id) || !id.test(action.provider_id) ||
        action.schema_version !== 1 || action.finding_ids.length === 0 ||
        action.finding_ids.some((findingId) => !id.test(findingId)) ||
        action.expected_writes.some((path) => !safeRelativePath(path)) ||
        action.expected_writes.length !== new Set(action.expected_writes).size ||
        action.invalidates_providers.some((providerId) => !id.test(providerId)) ||
        !sha.test(action.invalidation_hash) ||
        !Number.isSafeInteger(action.estimated_duration_ms) || action.estimated_duration_ms < 0 ||
        action.depends_on.some((dependency) => !byId.has(dependency)) ||
        action.depends_on.includes(action.action_id) || action.conflicts_with.includes(action.action_id)) {
      throw new SyncMaintenanceError("SYNC_PLAN_INVALID");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (actionId: string): void => {
    if (visiting.has(actionId)) throw new SyncMaintenanceError("SYNC_PLAN_INVALID");
    if (visited.has(actionId)) return;
    visiting.add(actionId);
    for (const dependency of byId.get(actionId)?.depends_on ?? []) visit(dependency);
    visiting.delete(actionId);
    visited.add(actionId);
  };
  for (const action of actions) visit(action.action_id);
}

export function createSyncProviderRegistry(
  providerList: readonly SyncActionProvider[]
): SyncProviderRegistry {
  const providers = new Map<string, SyncActionProvider>();
  for (const provider of providerList) {
    if (!id.test(provider.provider_id) || providers.has(provider.provider_id)) {
      throw new SyncMaintenanceError("SYNC_PLAN_INVALID");
    }
    providers.set(provider.provider_id, provider);
  }
  const provider_ids = deepFreeze([...providers.keys()].sort(compareCodepoint));
  return Object.freeze({ provider_ids, get: (providerId: string) => providers.get(providerId) });
}

function selectedActionOrder(plan: SyncPlan, actionIds: readonly string[]): SyncActionPlan[] {
  const selectedIds = sortedUnique(actionIds);
  if (selectedIds.length === 0 || selectedIds.length !== actionIds.length) {
    throw new SyncMaintenanceError("SYNC_ACTION_SELECTION_INVALID");
  }
  const all = new Map(plan.actions.map((action) => [action.action_id, action]));
  const selected = new Set(selectedIds);
  for (const actionId of selectedIds) {
    const action = all.get(actionId);
    if (action === undefined || action.depends_on.some((dependency) => !selected.has(dependency)) ||
        action.conflicts_with.some((conflict) => selected.has(conflict))) {
      throw new SyncMaintenanceError("SYNC_ACTION_SELECTION_INVALID");
    }
    for (const other of plan.actions) {
      if (selected.has(other.action_id) && other.conflicts_with.includes(actionId)) {
        throw new SyncMaintenanceError("SYNC_ACTION_SELECTION_INVALID");
      }
    }
  }
  const ordered: SyncActionPlan[] = [];
  const visited = new Set<string>();
  const visit = (actionId: string): void => {
    if (visited.has(actionId)) return;
    const action = all.get(actionId);
    if (action === undefined) throw new SyncMaintenanceError("SYNC_ACTION_SELECTION_INVALID");
    for (const dependency of action.depends_on) visit(dependency);
    visited.add(actionId);
    ordered.push(action);
  };
  for (const actionId of selectedIds) visit(actionId);
  return ordered;
}

function validateConfirmation(plan: SyncPlan, actions: readonly SyncActionPlan[],
  confirmation: SyncApplyConfirmation): void {
  const actionIds = actions.map((action) => action.action_id).sort(compareCodepoint);
  const approved = sortedUnique(confirmation.approved_action_ids);
  const requiresWrites = actions.some((action) => action.expected_writes.length > 0);
  const requiresNetwork = actions.some((action) => action.network_access);
  const requiresModel = actions.some((action) => action.model_access);
  const confirmed = new Date(confirmation.confirmed_at).getTime();
  if (!exactKeys(confirmation, [
    "schema_version", "plan_id", "preview_hash", "approved_action_ids", "allow_writes",
    "allow_network", "allow_model", "confirmed_at"
  ]) || confirmation.schema_version !== 1 || confirmation.plan_id !== plan.plan_id ||
      confirmation.preview_hash !== plan.preview_hash ||
      confirmation.approved_action_ids.length !== approved.length ||
      approved.length !== actionIds.length || approved.some((id, index) => id !== actionIds[index]) ||
      (requiresWrites && !confirmation.allow_writes) ||
      (requiresNetwork && !confirmation.allow_network) ||
      (requiresModel && !confirmation.allow_model) ||
      !Number.isFinite(confirmed) || confirmed < new Date(plan.created_at).getTime() ||
      confirmed >= new Date(plan.expires_at).getTime()) {
    throw new SyncMaintenanceError("SYNC_CONFIRMATION_REQUIRED");
  }
}

function validateReceipt(action: SyncActionPlan, receipt: SyncActionReceipt): void {
  const paths = sortedUnique(receipt.modified_paths);
  const expected = new Set(action.expected_writes);
  if (!exactKeys(receipt, [
    "schema_version", "action_id", "provider_id", "input_hash", "output_hash",
    "evidence_sources", "wrote", "modified_paths", "rollback", "auto_fixed",
    "duration_ms", "completed_at"
  ]) || !exactKeys(receipt.rollback, ["strategy", "available"], ["rollback_token"]) ||
      receipt.schema_version !== 1 || receipt.action_id !== action.action_id ||
      receipt.provider_id !== action.provider_id || receipt.input_hash !== action.invalidation_hash ||
      !sha.test(receipt.output_hash) || receipt.evidence_sources.length === 0 ||
      receipt.evidence_sources.some((source) => source.trim() === "") ||
      receipt.modified_paths.length !== paths.length || paths.some((path) => !expected.has(path)) ||
      receipt.wrote !== (paths.length > 0) || receipt.wrote === (receipt.output_hash === receipt.input_hash) ||
      receipt.auto_fixed !== receipt.wrote || receipt.rollback.strategy !== action.rollback_strategy ||
      receipt.rollback.available !== (receipt.rollback.rollback_token !== undefined) ||
      !Number.isSafeInteger(receipt.duration_ms) || receipt.duration_ms < 0 ||
      !Number.isFinite(new Date(receipt.completed_at).getTime())) {
    throw new SyncMaintenanceError("SYNC_PROVIDER_RECEIPT_INVALID");
  }
}

function validateVerification(receipt: SyncActionReceipt, verification: SyncVerification): void {
  if (verification.schema_version !== 1 || verification.action_id !== receipt.action_id ||
      verification.provider_id !== receipt.provider_id || !sha.test(verification.evidence_hash) ||
      !Number.isFinite(new Date(verification.verified_at).getTime())) {
    throw new SyncMaintenanceError("SYNC_PROVIDER_RECEIPT_INVALID");
  }
  if (verification.status !== "verified") {
    throw new SyncMaintenanceError("SYNC_VERIFICATION_FAILED", true);
  }
}

function validRollbackReceipt(
  action: SyncActionPlan,
  receipt: SyncRollbackReceipt
): boolean {
  return exactKeys(receipt, [
    "schema_version", "action_id", "provider_id", "status", "reason_code",
    "evidence_hash", "completed_at"
  ]) && receipt.schema_version === 1 && receipt.action_id === action.action_id &&
    receipt.provider_id === action.provider_id &&
    (["rolled_back", "failed", "not_available"] as const).includes(receipt.status) &&
    id.test(receipt.reason_code.toLowerCase()) && sha.test(receipt.evidence_hash) &&
    Number.isFinite(new Date(receipt.completed_at).getTime());
}

export function createSyncMaintenanceModule(input: {
  readonly providers: readonly SyncActionProvider[] | SyncProviderRegistry;
  readonly clock?: (() => Date) | undefined;
  readonly plan_ttl_ms?: number | undefined;
  readonly max_concurrency?: number | undefined;
}): SyncMaintenanceModule {
  const clock = input.clock ?? (() => new Date());
  const ttl = input.plan_ttl_ms ?? 300_000;
  const concurrency = input.max_concurrency ?? 4;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || !Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new SyncMaintenanceError("SYNC_PLAN_INVALID");
  }
  const registry = Array.isArray(input.providers)
    ? createSyncProviderRegistry(input.providers)
    : input.providers as SyncProviderRegistry;
  const plans = new Map<string, { readonly plan: SyncPlan; readonly context: SyncContext }>();
  const consumedPlans = new Set<string>();

  async function inspect(context: SyncContext, provider_ids?: readonly string[]): Promise<SyncPlan> {
    if (!validContext(context)) throw new SyncMaintenanceError("SYNC_CONTEXT_INVALID");
    const selectedIds = provider_ids === undefined ? [...registry.provider_ids] : sortedUnique(provider_ids);
    if (selectedIds.some((providerId) => registry.get(providerId) === undefined)) {
      throw new SyncMaintenanceError("SYNC_PLAN_INVALID");
    }
    const selected = selectedIds.map((providerId) => registry.get(providerId) as SyncActionProvider);
    const outcomes = await boundedMap(selected, concurrency, async (provider) => {
      const started = clock().getTime();
      try {
        const applicability = await provider.applicable(context);
        if (!exactKeys(applicability, ["applicability", "reason_code"]) ||
            !(["applicable", "not_applicable", "unavailable"] as const)
              .includes(applicability.applicability) || !id.test(applicability.reason_code.toLowerCase())) {
          throw new Error("provider applicability contract invalid");
        }
        if (applicability.applicability !== "applicable") {
          return { result: {
            provider_id: provider.provider_id,
            applicability: applicability.applicability,
            status: "UNKNOWN" as const,
            urgency: "none" as const,
            reason_code: applicability.reason_code,
            findings: [],
            duration_ms: Math.max(0, clock().getTime() - started)
          }, actions: [] as readonly SyncActionPlan[] };
        }
        const findings = await provider.inspect(context);
        if (findings.some((item) => !validFinding(item, provider.provider_id))) {
          throw new Error("provider finding contract invalid");
        }
        const actions = await provider.plan(context, findings.map((item) => item.finding_id));
        const findingIds = new Set(findings.map((item) => item.finding_id));
        if (actions.some((item) => !validActionDeclaration(item, provider.provider_id) ||
            item.finding_ids.some((findingId) => !findingIds.has(findingId)))) {
          throw new Error("provider action contract invalid");
        }
        return {
          result: aggregateResult(provider.provider_id, applicability, findings,
            Math.max(0, clock().getTime() - started)),
          actions
        };
      } catch (error) {
        if (error instanceof SyncMaintenanceError) throw error;
        return { result: {
          provider_id: provider.provider_id,
          applicability: "unavailable" as const,
          status: "UNKNOWN" as const,
          urgency: "none" as const,
          reason_code: "PROVIDER_INSPECTION_FAILED",
          findings: [],
          duration_ms: Math.max(0, clock().getTime() - started),
          degradation_reason: error instanceof Error ? error.name : "unknown_error"
        }, actions: [] as readonly SyncActionPlan[] };
      }
    });
    const provider_results = outcomes.map((item) => item.result)
      .sort((left, right) => compareCodepoint(left.provider_id, right.provider_id));
    const findings = provider_results.flatMap((item) => item.findings)
      .sort((left, right) => compareCodepoint(left.finding_id, right.finding_id));
    const actions = outcomes.flatMap((item) => item.actions)
      .sort((left, right) => compareCodepoint(left.action_id, right.action_id));
    assertActionGraph(actions);
    const created = clock();
    const input_hash = stableHash({ context_hash: context.context_hash, provider_ids: selectedIds });
    const preview_hash = stableHash({ input_hash, provider_results, actions });
    const planId = `sync_plan:${stableHash({ preview_hash, created_at: created.toISOString() })
      .slice("sha256:".length)}` as const;
    const plan = deepFreeze({
      schema_version: 1 as const,
      plan_id: planId,
      context_hash: context.context_hash,
      input_hash,
      provider_results,
      findings,
      actions,
      expected_writes: sortedUnique(actions.flatMap((item) => item.expected_writes)),
      preview_hash,
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + ttl).toISOString(),
      summary: summary(provider_results)
    });
    plans.set(plan.plan_id, { plan, context });
    return plan;
  }

  async function verify(receipts: readonly SyncActionReceipt[]): Promise<readonly SyncVerification[]> {
    const verifications = await Promise.all(receipts.map(async (receipt) => {
      const provider = registry.get(receipt.provider_id);
      if (provider === undefined) throw new SyncMaintenanceError("SYNC_PROVIDER_RECEIPT_INVALID");
      const verification = await provider.verify(receipt);
      validateVerification(receipt, verification);
      return verification;
    }));
    return deepFreeze(verifications);
  }

  async function apply(plan_id: SyncPlan["plan_id"], preview_hash: SyncPlan["preview_hash"],
    action_ids: readonly string[], confirmation: SyncApplyConfirmation): Promise<SyncApplyResult> {
    if (consumedPlans.has(plan_id)) throw new SyncMaintenanceError("SYNC_PLAN_STALE");
    const saved = plans.get(plan_id);
    if (saved === undefined) throw new SyncMaintenanceError("SYNC_PLAN_NOT_FOUND");
    if (preview_hash !== saved.plan.preview_hash) throw new SyncMaintenanceError("SYNC_PLAN_STALE");
    if (clock().getTime() >= new Date(saved.plan.expires_at).getTime()) {
      throw new SyncMaintenanceError("SYNC_PLAN_EXPIRED", true);
    }
    const actions = selectedActionOrder(saved.plan, action_ids);
    validateConfirmation(saved.plan, actions, confirmation);

    const findingsByProvider = new Map<string, string[]>();
    for (const action of actions) {
      const ids = findingsByProvider.get(action.provider_id) ?? [];
      ids.push(...action.finding_ids);
      findingsByProvider.set(action.provider_id, sortedUnique(ids));
    }
    for (const [providerId, findingIds] of findingsByProvider) {
      const provider = registry.get(providerId);
      if (provider === undefined) throw new SyncMaintenanceError("SYNC_PLAN_STALE");
      let refreshed: readonly SyncActionPlan[];
      try {
        refreshed = await provider.plan(saved.context, findingIds);
      } catch {
        throw new SyncMaintenanceError("SYNC_PLAN_STALE", true);
      }
      const refreshedById = new Map(refreshed.map((action) => [action.action_id, action]));
      for (const action of actions.filter((item) => item.provider_id === providerId)) {
        const current = refreshedById.get(action.action_id);
        if (current === undefined || stableHash(current) !== stableHash(action)) {
          throw new SyncMaintenanceError("SYNC_PLAN_STALE", true);
        }
      }
    }

    const receipts: SyncActionReceipt[] = [];
    const appliedActions: SyncActionPlan[] = [];
    async function failWithRollback(
      failedAction: SyncActionPlan,
      reason_code: SyncApplyFailureEvidence["reason_code"]
    ): Promise<never> {
      const rollbackReceipts: SyncRollbackReceipt[] = [];
      let rollbackFailed = false;
      for (let index = receipts.length - 1; index >= 0; index -= 1) {
        const appliedReceipt = receipts[index];
        const appliedAction = appliedActions[index];
        if (appliedReceipt === undefined || appliedAction === undefined || appliedReceipt.wrote !== true) continue;
        if (appliedReceipt.rollback?.strategy === "none" ||
            appliedReceipt.rollback?.available !== true) {
          rollbackFailed = true;
          rollbackReceipts.push({
            schema_version: 1,
            action_id: appliedAction.action_id,
            provider_id: appliedAction.provider_id,
            status: "not_available",
            reason_code: "ROLLBACK_NOT_AVAILABLE",
            evidence_hash: stableHash({
              action_id: appliedAction.action_id,
              output_hash: appliedReceipt.output_hash,
              reason_code: "ROLLBACK_NOT_AVAILABLE"
            }),
            completed_at: clock().toISOString()
          });
          continue;
        }
        const provider = registry.get(appliedAction.provider_id);
        try {
          if (provider === undefined) throw new Error("provider unavailable");
          const rollbackReceipt = await provider.rollback(appliedAction, appliedReceipt);
          if (!validRollbackReceipt(appliedAction, rollbackReceipt)) {
            throw new Error("rollback receipt invalid");
          }
          if (rollbackReceipt.status !== "rolled_back") rollbackFailed = true;
          rollbackReceipts.push(rollbackReceipt);
        } catch (error) {
          rollbackFailed = true;
          rollbackReceipts.push({
            schema_version: 1,
            action_id: appliedAction.action_id,
            provider_id: appliedAction.provider_id,
            status: "failed",
            reason_code: "PROVIDER_ROLLBACK_FAILED",
            evidence_hash: stableHash({
              action_id: appliedAction.action_id,
              output_hash: appliedReceipt.output_hash,
              error_name: error instanceof Error ? error.name : "unknown_error"
            }),
            completed_at: clock().toISOString()
          });
        }
      }
      const hadSideEffectBoundary = consumedPlans.has(plan_id);
      const failureEvidence = deepFreeze({
        schema_version: 1 as const,
        plan_id,
        preview_hash,
        failed_action_id: failedAction.action_id,
        reason_code,
        receipts: [...receipts],
        rollback_receipts: rollbackReceipts,
        failed_at: clock().toISOString()
      });
      throw new SyncMaintenanceError(
        rollbackFailed ? "SYNC_ROLLBACK_FAILED" : "SYNC_APPLY_FAILED",
        !hadSideEffectBoundary,
        failureEvidence
      );
    }
    for (const action of actions) {
      const provider = registry.get(action.provider_id);
      if (provider === undefined) throw new SyncMaintenanceError("SYNC_PLAN_STALE");
      consumedPlans.add(plan_id);
      let receipt: SyncActionReceipt;
      try {
        receipt = await provider.apply(action, confirmation);
      } catch {
        return failWithRollback(action, "PROVIDER_APPLY_FAILED");
      }
      receipts.push(receipt);
      appliedActions.push(action);
      if (receipt.wrote) consumedPlans.add(plan_id);
      try {
        validateReceipt(action, receipt);
      } catch {
        await failWithRollback(action, "PROVIDER_RECEIPT_INVALID");
      }
    }
    const verifications: SyncVerification[] = [];
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = receipts[index];
      const action = appliedActions[index];
      if (receipt === undefined || action === undefined) continue;
      const provider = registry.get(receipt.provider_id);
      try {
        if (provider === undefined) throw new Error("provider unavailable");
        const verification = await provider.verify(receipt);
        validateVerification(receipt, verification);
        verifications.push(verification);
      } catch {
        await failWithRollback(action, "PROVIDER_VERIFICATION_FAILED");
      }
    }
    const invalidated = sortedUnique(actions.flatMap((action) =>
      [action.provider_id, ...action.invalidates_providers]
    ));
    const rechecked: SyncProviderResult[] = [];
    for (const providerId of invalidated) {
      const provider = registry.get(providerId);
      if (provider === undefined) continue;
      const started = clock().getTime();
      try {
        const applicability = await provider.applicable(saved.context);
        if (applicability.applicability !== "applicable") {
          rechecked.push({
            provider_id: providerId,
            applicability: applicability.applicability,
            status: "UNKNOWN",
            urgency: "none",
            reason_code: applicability.reason_code,
            findings: [],
            duration_ms: Math.max(0, clock().getTime() - started)
          });
        } else {
          const findings = await provider.inspect(saved.context);
          rechecked.push(aggregateResult(providerId, applicability, findings,
            Math.max(0, clock().getTime() - started)));
        }
      } catch (error) {
        rechecked.push({
          provider_id: providerId,
          applicability: "unavailable",
          status: "UNKNOWN",
          urgency: "none",
          reason_code: "PROVIDER_VERIFICATION_RECHECK_FAILED",
          findings: [],
          duration_ms: Math.max(0, clock().getTime() - started),
          degradation_reason: error instanceof Error ? error.name : "unknown_error"
        });
      }
    }
    const changed_paths = sortedUnique(receipts.flatMap((receipt) => receipt.modified_paths));
    const completedAt = clock().toISOString();
    consumedPlans.add(plan_id);
    const result: SyncApplyResult = {
      schema_version: 1,
      plan_id,
      preview_hash,
      applied_action_ids: actions.map((action) => action.action_id),
      receipts,
      verifications,
      rechecked_providers: rechecked.sort((left, right) =>
        compareCodepoint(left.provider_id, right.provider_id)),
      changed_paths,
      no_changes: changed_paths.length === 0,
      ...(changed_paths.length === 0 || saved.context.platform_binding === undefined ? {} : {
        remote_sync_request_intent: {
          schema_version: 1 as const,
          request_id: `sync_remote_intent:${stableHash({
            plan_id, changed_paths, context_hash: saved.context.context_hash
          }).slice("sha256:".length)}` as const,
          context_hash: saved.context.context_hash,
          changed_paths,
          reason_code: "local_sync_changes_available" as const
        }
      }),
      completed_at: completedAt
    };
    return deepFreeze(result);
  }

  return { inspect, apply, verify };
}
