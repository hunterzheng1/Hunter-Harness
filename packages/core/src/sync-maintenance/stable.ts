import { createHash } from "node:crypto";

import { SyncMaintenanceError } from "./errors.js";
import type { SyncContext, SyncContextInput, SyncSha256 } from "./types.js";

const identifier = /^[a-z0-9][a-z0-9._:-]*$/u;
const commit = /^[a-f0-9]{40,64}$/u;
const forbiddenRefCharacters = new Set([" ", "~", "^", ":", "?", "*", "[", "\\"]);

function exactKeys(value: object, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function plainDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function safeRelativePath(path: string): boolean {
  if (path === "" || path !== path.trim() || path.includes("\\") || path.startsWith("/") ||
      /^[a-z]:/iu.test(path)) return false;
  const segments = path.split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === ".." ||
    segment.startsWith(".env") || segment === "credentials.local" ||
    segment.startsWith("credentials.local."));
}

export function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    value === value.trim() && value === value.normalize("NFC") &&
    ![...value].some((character) => {
      const codepoint = character.codePointAt(0) ?? 0;
      return codepoint <= 31 || codepoint === 127;
    });
}

function normalizedUpstreamRef(value: unknown): value is string {
  if (!normalizedText(value, 255) || [...value].some((character) =>
    forbiddenRefCharacters.has(character)) ||
      value.startsWith("/") || value.endsWith("/") || value.endsWith(".") ||
      value.includes("..") || value.includes("@{")) return false;
  return value.split("/").every((segment) =>
    segment !== "" && segment !== "." && segment !== ".." && !segment.endsWith(".lock")
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodepoint(left, right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function stableHash(value: unknown): SyncSha256 {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodepoint);
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function syncContextPayload(input: SyncContextInput): SyncContextInput {
  return {
    schema_version: 1,
    project_identity: input.project_identity,
    repository_identity: input.repository_identity,
    worktree_identity: input.worktree_identity,
    current_commit: input.current_commit,
    upstream_ref: input.upstream_ref,
    project_change_set: {
      schema_version: 1,
      baseline_available: input.project_change_set.baseline_available,
      head_commit: input.project_change_set.head_commit,
      dirty_paths: sortedUnique(input.project_change_set.dirty_paths),
      untracked_paths: sortedUnique(input.project_change_set.untracked_paths)
    },
    enabled_agents: sortedUnique(input.enabled_agents),
    agent_profiles: Object.fromEntries(Object.entries(input.agent_profiles)
      .sort(([left], [right]) => compareCodepoint(left, right))),
    platform_binding: input.platform_binding,
    feature_flags: Object.fromEntries(Object.entries(input.feature_flags)
      .sort(([left], [right]) => compareCodepoint(left, right)))
  };
}

export function createSyncContext(input: SyncContextInput): SyncContext {
  const enabled = new Set(Array.isArray(input.enabled_agents) ? input.enabled_agents : []);
  const profiles = plainDataRecord(input.agent_profiles)
    ? input.agent_profiles
    : {};
  const profileAgents = Object.keys(profiles);
  if (!exactKeys(input, [
    "schema_version", "project_identity", "project_change_set", "enabled_agents",
    "agent_profiles", "feature_flags"
  ], ["repository_identity", "worktree_identity", "current_commit", "upstream_ref", "platform_binding"]) ||
      !exactKeys(input.project_change_set, [
        "schema_version", "baseline_available", "dirty_paths", "untracked_paths"
      ], ["head_commit"]) ||
      (input.platform_binding !== undefined && !exactKeys(input.platform_binding, ["project_id"])) ||
      input.schema_version !== 1 || !normalizedText(input.project_identity, 256) ||
      (input.repository_identity !== undefined &&
        !normalizedText(input.repository_identity, 256)) ||
      (input.worktree_identity !== undefined && !normalizedText(input.worktree_identity, 256)) ||
      (input.current_commit !== undefined && !commit.test(input.current_commit)) ||
      (input.upstream_ref !== undefined && !normalizedUpstreamRef(input.upstream_ref)) ||
      input.project_change_set.schema_version !== 1 ||
      typeof input.project_change_set.baseline_available !== "boolean" ||
      (input.project_change_set.head_commit !== undefined && !commit.test(input.project_change_set.head_commit)) ||
      !Array.isArray(input.project_change_set.dirty_paths) ||
      !Array.isArray(input.project_change_set.untracked_paths) ||
      input.project_change_set.dirty_paths.some((path) => !safeRelativePath(path)) ||
      input.project_change_set.untracked_paths.some((path) => !safeRelativePath(path)) ||
      !Array.isArray(input.enabled_agents) || input.enabled_agents.length === 0 ||
      input.enabled_agents.length > 32 || input.enabled_agents.some((agent) =>
        typeof agent !== "string" || agent.length > 64 || !identifier.test(agent)) ||
      !plainDataRecord(input.agent_profiles) ||
      enabled.size !== input.enabled_agents.length ||
      profileAgents.length !== enabled.size ||
      profileAgents.some((agent) => !enabled.has(agent) ||
        !normalizedText(profiles[agent], 128)) ||
      [...enabled].some((agent) => !Object.hasOwn(profiles, agent)) ||
      (input.platform_binding !== undefined &&
        !normalizedText(input.platform_binding.project_id, 128)) ||
      input.feature_flags === null || typeof input.feature_flags !== "object" ||
      Object.entries(input.feature_flags).some(([flag, enabledFlag]) =>
        !identifier.test(flag) || typeof enabledFlag !== "boolean")) {
    throw new SyncMaintenanceError("SYNC_CONTEXT_INVALID");
  }
  const payload = syncContextPayload(input);
  return deepFreeze({ ...payload, context_hash: stableHash(payload) });
}

export { safeRelativePath };
