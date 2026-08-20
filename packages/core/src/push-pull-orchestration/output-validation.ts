import { isProxy } from "node:util/types";

import { classifyContentPath, remoteVersionIdentitySchema } from "@hunter-harness/contracts";

import { validateSyncOperation, type SourceRef, type SyncOperation } from "../remote-sync/index.js";
import type {
  PushPullDecisionInput,
  PushPullDecisionResult,
  PushPullDirection,
  PushPullExecutionReceipt,
  PushPullInteractionInput,
  PushPullPreview
} from "./types.js";
import {
  allowedPushPullDecisionStatuses,
  ordinaryRequestInvariant,
  pushPullPreviewOutcome,
  pushPullReceiptStatus
} from "./stable.js";

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return keys.length >= required.length && required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function snapshot(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  budget.nodes += 1;
  if (depth > 24 || budget.nodes > 8192 || (value !== null && typeof value === "object" && isProxy(value))) {
    throw new Error("unsafe output");
  }
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value !== "object") throw new Error("unsafe output");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error("unsafe output");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) throw new Error("unsafe output");
  if (array) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 4096 || keys.length !== length + 1) {
      throw new Error("unsafe output");
    }
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new Error("unsafe output");
      return snapshot(descriptor.value, depth + 1, budget);
    });
  }
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new Error("unsafe output");
    result[key] = snapshot(descriptor.value, depth + 1, budget);
  }
  return result;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && value === value.trim();
}

function source(value: unknown): SourceRef | undefined {
  if (!record(value) || !exact(value, ["project_id", "branch_name", "commit_sha", "client_id"], ["change_key"]) ||
      !text(value.project_id) || !text(value.branch_name) || !text(value.commit_sha) || !text(value.client_id) ||
      (value.change_key !== undefined && !text(value.change_key))) return undefined;
  return value as unknown as SourceRef;
}

function sameSource(left: SourceRef, right: SourceRef): boolean {
  return left.project_id === right.project_id && left.branch_name === right.branch_name &&
    left.commit_sha === right.commit_sha && left.client_id === right.client_id && left.change_key === right.change_key;
}

function display(value: unknown): boolean {
  return record(value) && exact(value, ["heading", "summary", "detail_lines"]) && text(value.heading) &&
    text(value.summary) && Array.isArray(value.detail_lines) && value.detail_lines.every(text);
}

function operation(value: unknown, conflict = false): value is SyncOperation {
  const required = conflict ? ["path", "content_kind", "action", "reason_code"] : ["path", "content_kind", "action"];
  if (!record(value) || !exact(value, required, ["source_path", "local_hash", "remote_hash", "base_hash"]) ||
      !text(value.path) || !["local_hash", "remote_hash", "base_hash"].every((key) =>
        value[key] === undefined || text(value[key])) ||
      !validateSyncOperation(value as unknown as SyncOperation).ok) return false;
  return !conflict || value.reason_code === "SYNC_CONTENT_CONFLICT" ||
    value.reason_code === "SYNC_RENAME_TARGET_CONFLICT";
}

function operations(value: unknown, conflict = false): value is SyncOperation[] {
  return Array.isArray(value) && value.every((item) => operation(item, conflict));
}

function finding(value: unknown): boolean {
  return record(value) && exact(value, ["rule_id", "severity", "path", "line", "column", "fingerprint",
    "redacted_preview", "overridable", "disposition"]) && text(value.rule_id) && text(value.path) &&
    Number.isSafeInteger(value.line) && (value.line as number) > 0 && Number.isSafeInteger(value.column) &&
    (value.column as number) > 0 && text(value.fingerprint) && text(value.redacted_preview) &&
    typeof value.overridable === "boolean" && ["high", "medium", "low"].includes(value.severity as string) &&
    ["blocked", "overridden"].includes(value.disposition as string) &&
    (value.severity === "high" ? value.overridable === false : value.overridable === true) &&
    (value.disposition !== "overridden" || value.overridable === true);
}

export function readPushPullPreviewOutput(value: unknown, direction: PushPullDirection,
  input: PushPullInteractionInput): PushPullPreview | undefined {
  let copy: unknown;
  try { copy = snapshot(value); } catch { return undefined; }
  if (!record(copy) || !exact(copy, ["schema_version", "direction", "preview_hash", "source_ref", "scopes",
    "outcome", "base_version", "operations", "conflicts", "security_scan", "display_zh"], ["remote_version"]) ||
      copy.schema_version !== 1 || copy.direction !== direction || !text(copy.preview_hash) ||
      !(copy.base_version === null || text(copy.base_version)) || !display(copy.display_zh)) return undefined;
  const outputSource = source(copy.source_ref);
  const expectedScopes = ordinaryRequestInvariant(direction, input.source_mode, input.scopes);
  if (outputSource === undefined || !sameSource(outputSource, input.source_ref) || !Array.isArray(copy.scopes) ||
      copy.scopes.length === 0 || copy.scopes.some((scope) => !["config", "rules", "architecture", "instructions",
        "branch_files"].includes(scope as string)) || !expectedScopes.ok ||
      copy.scopes.length !== expectedScopes.scopes.length ||
      copy.scopes.some((scope, index) => scope !== expectedScopes.scopes[index]) ||
      !operations(copy.operations) || !operations(copy.conflicts, true) ||
      (direction === "push" && copy.operations.some((item) => item.action === "restore")) ||
      (copy.remote_version !== undefined && !remoteVersionIdentitySchema.safeParse(copy.remote_version).success)) return undefined;
  if (!record(copy.security_scan) || !exact(copy.security_scan,
    ["scanner_version", "blocked", "hard_blocked", "review_required", "findings"]) ||
      !text(copy.security_scan.scanner_version) || typeof copy.security_scan.blocked !== "boolean" ||
      typeof copy.security_scan.hard_blocked !== "boolean" || typeof copy.security_scan.review_required !== "boolean" ||
      !Array.isArray(copy.security_scan.findings) || !copy.security_scan.findings.every(finding)) return undefined;
  const blocked = copy.security_scan.findings.filter((item) =>
    (item as Record<string, unknown>).disposition === "blocked");
  if (copy.security_scan.blocked !== (blocked.length > 0) ||
      copy.security_scan.hard_blocked !== blocked.some((item) =>
        (item as Record<string, unknown>).severity === "high") ||
      copy.security_scan.review_required !== blocked.some((item) =>
        (item as Record<string, unknown>).severity !== "high")) return undefined;
  const projected = copy as unknown as PushPullPreview;
  return copy.outcome === pushPullPreviewOutcome(projected) ? projected : undefined;
}

export function readPushPullDecisionOutput(value: unknown, direction: PushPullDirection, previewHash: string,
  input: PushPullDecisionInput): PushPullDecisionResult | undefined {
  let copy: unknown;
  try { copy = snapshot(value); } catch { return undefined; }
  if (!record(copy) || copy.schema_version !== 1 || copy.direction !== direction || copy.preview_hash !== previewHash ||
      !display(copy.display_zh) || !allowedPushPullDecisionStatuses(input.action).has(
        copy.status as PushPullDecisionResult["status"])) return undefined;
  const confirmed = copy.status === "confirmed";
  if (!exact(copy, confirmed ? ["schema_version", "status", "direction", "preview_hash", "confirmation_id", "display_zh"] :
    ["schema_version", "status", "direction", "preview_hash", "display_zh"]) ||
      (confirmed && !text(copy.confirmation_id))) return undefined;
  return copy as unknown as PushPullDecisionResult;
}

export function readPushPullExecutionOutput(value: unknown, direction: PushPullDirection):
PushPullExecutionReceipt | undefined {
  let copy: unknown;
  try { copy = snapshot(value); } catch { return undefined; }
  if (!record(copy) || !exact(copy,
    ["schema_version", "direction", "preview_hash", "status", "sync_receipt", "display_zh"]) ||
      copy.schema_version !== 1 || copy.direction !== direction || !text(copy.preview_hash) || !display(copy.display_zh) ||
      !record(copy.sync_receipt) || !exact(copy.sync_receipt,
        ["preview_hash", "no_changes", "applied", "skipped", "retryable"],
        ["project_version", "artifact_id", "reason_code"]) || copy.sync_receipt.preview_hash !== copy.preview_hash ||
      typeof copy.sync_receipt.no_changes !== "boolean" || !operations(copy.sync_receipt.applied) ||
      !operations(copy.sync_receipt.skipped) || !operations(copy.sync_receipt.retryable)) return undefined;
  const receipt = copy.sync_receipt as unknown as PushPullExecutionReceipt["sync_receipt"];
  if (!(receipt.reason_code === undefined || ["SYNC_LOCK_UNAVAILABLE", "REMOTE_UNAVAILABLE",
    "REMOTE_PUBLISH_FAILED", "PULL_TRANSACTION_FAILED", "SYNC_CANCELLED"].includes(receipt.reason_code)) ||
      (receipt.project_version !== undefined && !text(receipt.project_version)) ||
      (receipt.artifact_id !== undefined && !text(receipt.artifact_id))) return undefined;
  if (copy.status !== pushPullReceiptStatus(receipt)) return undefined;
  return copy as unknown as PushPullExecutionReceipt;
}

export interface PushPullOutputViolation {
  readonly violated: string;
  readonly detail: string;
}

/**
 * Explain *why* a preview output was rejected.
 *
 * The validator itself stays a fast boolean gate on the hot path; this walks the
 * same invariants once, only when something already failed, so a caller gets a
 * field name instead of an opaque code. Diagnosing this class of failure used to
 * be impossible from the outside: every check funnelled into one `undefined`.
 */
export function explainPushPullPreviewOutput(
  value: unknown,
  direction: PushPullDirection,
  input: PushPullInteractionInput
): PushPullOutputViolation | undefined {
  if (readPushPullPreviewOutput(value, direction, input) !== undefined) return undefined;
  let copy: unknown;
  try { copy = snapshot(value); } catch {
    return { violated: "output.shape", detail: "输出无法安全快照（可能带有访问器或代理）" };
  }
  if (!record(copy)) return { violated: "output.type", detail: "输出不是对象" };
  if (copy.schema_version !== 1) {
    return { violated: "schema_version", detail: `期望 1，实际 ${String(copy.schema_version)}` };
  }
  if (copy.direction !== direction) {
    return { violated: "direction", detail: `期望 ${direction}，实际 ${String(copy.direction)}` };
  }
  const expectedScopes = ordinaryRequestInvariant(direction, input.source_mode, input.scopes);
  if (!expectedScopes.ok) {
    return { violated: "request.scopes", detail: `请求范围不合法：${expectedScopes.reason_code}` };
  }
  if (!Array.isArray(copy.scopes) ||
      copy.scopes.length !== expectedScopes.scopes.length ||
      copy.scopes.some((scope, index) => scope !== expectedScopes.scopes[index])) {
    return {
      violated: "scopes",
      detail: `期望 [${expectedScopes.scopes.join(", ")}]，实际 [${
        Array.isArray(copy.scopes) ? copy.scopes.map(String).join(", ") : String(copy.scopes)
      }]`
    };
  }
  if (source(copy.source_ref) === undefined) {
    return { violated: "source_ref", detail: "source_ref 字段缺失或非法" };
  }
  for (const [field, conflict] of [["operations", false], ["conflicts", true]] as const) {
    const list = copy[field];
    if (!Array.isArray(list)) {
      return { violated: field, detail: `${field} 不是数组` };
    }
    const index = list.findIndex((item) => !operation(item, conflict));
    if (index >= 0) {
      const item = list[index] as Record<string, unknown> | undefined;
      const path = typeof item?.path === "string" ? item.path : "(未知路径)";
      const kind = typeof item?.content_kind === "string" ? item.content_kind : "(未知)";
      const classified = classifyContentPath({ schema_version: 1, path });
      const classifiedKind = "content_kind" in classified
        ? classified.content_kind
        : classified.reason_code;
      return {
        violated: `${field}[${index}]`,
        detail: `path=${path} content_kind=${kind}，但该路径归类为 ${classifiedKind}` +
          (kind === "branch_file" && "content_kind" in classified
            ? `。branch_file 只接受无法归类的路径；${path} 属于 ${classified.sync_scope} 范围，` +
              `应由该范围推送，不要放进 branch_files。`
            : "")
      };
    }
  }
  if (!record(copy.security_scan)) {
    return { violated: "security_scan", detail: "security_scan 字段缺失或非法" };
  }
  return { violated: "output.unknown", detail: "输出未通过校验，但未定位到具体字段" };
}
