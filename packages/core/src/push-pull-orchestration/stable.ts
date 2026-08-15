import type {
  PushPullDecisionInput,
  PushPullDecisionResult,
  PushPullDirection,
  PushPullExecutionReceipt,
  PushPullPreviewOutcome,
  PushPullSourceMode,
  UserSyncScope
} from "./types.js";
import type { SyncPreview, SyncReceipt } from "../remote-sync/index.js";

const regularScopes = ["architecture", "config", "instructions", "rules"] as const;
const pushAllScopes = ["architecture", "branch_files", "config", "instructions", "rules"] as const;
const ordinaryScopes = new Set<Exclude<UserSyncScope, "all" | "archive">>(pushAllScopes);

export type OrdinaryRequestInvariant =
  | {
    readonly ok: true;
    readonly scopes: readonly Exclude<UserSyncScope, "all" | "archive">[];
  }
  | { readonly ok: false; readonly reason_code: "scope_invalid" | "source_required" };

export function ordinaryRequestInvariant(
  direction: PushPullDirection,
  sourceMode: PushPullSourceMode,
  requested: readonly UserSyncScope[] | undefined
): OrdinaryRequestInvariant {
  const values = requested === undefined || requested.length === 0 ? regularScopes : requested;
  if (values.some((scope) => scope === "archive" ||
      (scope !== "all" && !ordinaryScopes.has(scope)))) {
    return { ok: false, reason_code: "scope_invalid" };
  }
  const expanded = values.includes("all")
    ? direction === "push" ? pushAllScopes : regularScopes
    : values as readonly Exclude<UserSyncScope, "all" | "archive">[];
  const scopes = [...new Set(expanded)].sort(codepointCompare);
  if (direction === "pull" && scopes.includes("branch_files") && sourceMode !== "explicit") {
    return { ok: false, reason_code: "source_required" };
  }
  return { ok: true, scopes };
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(codepointCompare);
  const expected = [...keys].sort(codepointCompare);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function pushPullPreviewOutcome(preview: {
  readonly operations: readonly SyncPreview["operations"][number][];
  readonly conflicts: readonly SyncPreview["conflicts"][number][];
  readonly security_scan: SyncPreview["security_scan"];
}): PushPullPreviewOutcome {
  if (preview.operations.length === 0 && preview.conflicts.length === 0) return "no_changes";
  if (preview.conflicts.length > 0 || preview.operations.some((item) => item.action === "restore")) {
    return "needs_resolution";
  }
  if (preview.security_scan.blocked || preview.security_scan.review_required) {
    return "sensitive_confirmation_required";
  }
  return "ready";
}

export function allowedPushPullDecisionStatuses(action: PushPullDecisionInput["action"]):
ReadonlySet<PushPullDecisionResult["status"]> {
  return new Set(action === "continue" ? ["confirmed", "no_changes"] :
    action === "review" ? ["review_required", "no_changes"] : ["cancelled", "no_changes"]);
}

export function pushPullReceiptStatus(receipt: SyncReceipt): PushPullExecutionReceipt["status"] {
  if (receipt.no_changes) return "no_changes";
  if (receipt.reason_code === "SYNC_CANCELLED") return "cancelled";
  if (receipt.retryable.length > 0) return "retryable";
  return "completed";
}
