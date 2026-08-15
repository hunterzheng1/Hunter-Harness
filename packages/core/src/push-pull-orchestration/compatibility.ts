import type { SourceRef } from "../remote-sync/index.js";
import type {
  NormalizedPushPullRequest,
  NormalizePushPullResult,
  PushPullDirection,
  PushPullSourceMode,
  UserSyncScope
} from "./types.js";
import { exactKeys, ordinaryRequestInvariant } from "./stable.js";

const scopes = new Set<UserSyncScope>([
  "all", "config", "rules", "architecture", "instructions", "branch_files", "archive"
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseScopes(value: unknown): UserSyncScope[] | undefined {
  const values = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(values)) return undefined;
  const normalized = values.map((item) => typeof item === "string" ? item.trim() : item);
  if (normalized.some((item) => !scopes.has(item as UserSyncScope))) return undefined;
  return normalized as UserSyncScope[];
}

function parseSourceRef(value: unknown): SourceRef | undefined {
  if (!object(value)) return undefined;
  const allowed = value.change_key === undefined
    ? ["project_id", "branch_name", "commit_sha", "client_id"]
    : ["project_id", "branch_name", "commit_sha", "client_id", "change_key"];
  if (!exactKeys(value, allowed) || !nonempty(value.project_id) || !nonempty(value.branch_name) ||
      !nonempty(value.commit_sha) || !nonempty(value.client_id) ||
      (value.change_key !== undefined && !nonempty(value.change_key))) return undefined;
  return {
    project_id: value.project_id,
    branch_name: value.branch_name,
    commit_sha: value.commit_sha,
    client_id: value.client_id,
    ...(value.change_key === undefined ? {} : { change_key: value.change_key as string })
  };
}

function current(value: Record<string, unknown>): NormalizePushPullResult {
  if (!exactKeys(value, [
    "schema_version", "direction", "source_ref", "source_mode", "scopes"
  ])) return { ok: false, reason_code: "PUSH_PULL_COMPAT_INVALID" };
  const source_ref = parseSourceRef(value.source_ref);
  const parsedScopes = parseScopes(value.scopes);
  if ((value.direction !== "push" && value.direction !== "pull") || source_ref === undefined ||
      (value.source_mode !== "current" && value.source_mode !== "explicit") ||
      parsedScopes === undefined) return { ok: false, reason_code: "PUSH_PULL_COMPAT_INVALID" };
  if (!ordinaryRequestInvariant(value.direction, value.source_mode, parsedScopes).ok) {
    return { ok: false, reason_code: "PUSH_PULL_COMPAT_INVALID" };
  }
  return {
    ok: true,
    source_schema_version: 1,
    request: {
      schema_version: 1,
      direction: value.direction,
      source_ref,
      source_mode: value.source_mode,
      scopes: parsedScopes
    }
  };
}

function legacy(value: Record<string, unknown>): NormalizePushPullResult {
  const allowed = ["command", "direction", "projectId", "branchName", "commitSha", "clientId", "scope"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) ||
      (value.command !== "upload" && value.command !== "sync") ||
      !nonempty(value.projectId) || !nonempty(value.commitSha) || !nonempty(value.clientId) ||
      (value.branchName !== undefined && !nonempty(value.branchName))) {
    return { ok: false, reason_code: "PUSH_PULL_COMPAT_INVALID" };
  }
  const direction: PushPullDirection | undefined = value.command === "upload"
    ? (value.direction === undefined || value.direction === "push" ? "push" : undefined)
    : (value.direction === "push" || value.direction === "pull" ? value.direction : undefined);
  const parsedScopes = parseScopes(value.scope);
  if (direction === undefined || parsedScopes === undefined) {
    return { ok: false, reason_code: "PUSH_PULL_COMPAT_INVALID" };
  }
  const branchName = nonempty(value.branchName) ? value.branchName : "unmarked";
  const sourceMode: PushPullSourceMode = nonempty(value.branchName) ? "explicit" : "current";
  if (!ordinaryRequestInvariant(direction, sourceMode, parsedScopes).ok) {
    return { ok: false, reason_code: "PUSH_PULL_COMPAT_INVALID" };
  }
  const request: NormalizedPushPullRequest = {
    schema_version: 1,
    direction,
    source_ref: {
      project_id: value.projectId,
      branch_name: branchName,
      commit_sha: value.commitSha,
      client_id: value.clientId
    },
    source_mode: sourceMode,
    scopes: parsedScopes
  };
  return { ok: true, source_schema_version: 0, request };
}

export function normalizePushPullInput(value: unknown): NormalizePushPullResult {
  if (!object(value)) return { ok: false, reason_code: "PUSH_PULL_COMPAT_INVALID" };
  return value.schema_version === 1 ? current(value) : legacy(value);
}
