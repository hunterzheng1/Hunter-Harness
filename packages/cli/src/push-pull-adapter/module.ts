import { isProxy } from "node:util/types";

import type {
  ArchiveRemoteAdapter,
  PushPullDecisionInput,
  PushPullDirection,
  PushPullInteractionInput,
  PushPullOrchestration,
  SourceRef
} from "@hunter-harness/core";
import {
  normalizeArchiveRemoteRequest,
  readPushPullDecisionOutput,
  readPushPullExecutionOutput,
  readPushPullPreviewOutput,
  snapshotArchiveRemotePublishResult
} from "@hunter-harness/core";

import { PushPullCliAdapterError } from "./errors.js";
import type {
  PushPullCliDependencies,
  PushPullCliPort,
  PushPullCliResult
} from "./types.js";

const scopes = new Set(["all", "config", "rules", "architecture", "instructions", "branch_files"]);
const directions = new Set(["push", "pull"]);
const resolutions = new Set(["keep_local", "accept_remote", "skip"]);

function snapshotInput(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  budget.nodes += 1;
  if (depth > 24 || budget.nodes > 8192 ||
      (value !== null && (typeof value === "object" || typeof value === "function") && isProxy(value))) {
    throw new Error("unsafe input");
  }
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value !== "object") throw new Error("unsafe input");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error("unsafe input");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) throw new Error("unsafe input");
  if (array) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 4096 || keys.length !== length + 1) {
      throw new Error("unsafe input");
    }
    return Object.freeze(Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("unsafe input");
      }
      return snapshotInput(descriptor.value, depth + 1, budget);
    }));
  }
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("unsafe input");
    }
    result[key] = snapshotInput(descriptor.value, depth + 1, budget);
  }
  return Object.freeze(result);
}

function trySnapshotInput(value: unknown): unknown | undefined {
  try {
    return snapshotInput(value);
  } catch {
    return undefined;
  }
}

function dataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || isProxy(value) || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function valueAt(value: Readonly<Record<string, unknown>>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function exact(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
  try {
    const keys = Object.keys(value);
    return keys.length >= required.length && required.every((key) => Object.hasOwn(value, key)) &&
      keys.every((key) => required.includes(key) || optional.includes(key));
  } catch {
    return false;
  }
}

function text(value: unknown, maximum = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && value === value.normalize("NFC") &&
    ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 31);
}

function denseArray(value: unknown, maximum = 256): value is readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.at(-1) !== "length") return false;
    return Array.from({ length: value.length }, (_, index) => String(index)).every((key, index) => {
      if (keys[index] !== key) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function sourceRef(value: unknown): SourceRef | undefined {
  if (!dataRecord(value) || !exact(value,
    ["project_id", "branch_name", "commit_sha", "client_id"], ["change_key"])) return undefined;
  const project_id = valueAt(value, "project_id");
  const branch_name = valueAt(value, "branch_name");
  const commit_sha = valueAt(value, "commit_sha");
  const client_id = valueAt(value, "client_id");
  const change_key = valueAt(value, "change_key");
  if (!text(project_id) || !text(branch_name) || !text(commit_sha) || !text(client_id) ||
      (change_key !== undefined && !text(change_key))) return undefined;
  return Object.freeze({ project_id, branch_name, commit_sha, client_id,
    ...(change_key === undefined ? {} : { change_key }) });
}

function interaction(value: unknown): PushPullInteractionInput | undefined {
  if (!dataRecord(value) || !exact(value,
    ["schema_version", "source_ref", "source_mode"], ["scopes"]) ||
      valueAt(value, "schema_version") !== 1) return undefined;
  const source_ref = sourceRef(valueAt(value, "source_ref"));
  const source_mode = valueAt(value, "source_mode");
  const rawScopes = valueAt(value, "scopes");
  if (source_ref === undefined || (source_mode !== "current" && source_mode !== "explicit")) return undefined;
  if (rawScopes === undefined) return Object.freeze({ schema_version: 1, source_ref, source_mode });
  if (!denseArray(rawScopes) || !rawScopes.every((_, index) =>
    scopes.has(Object.getOwnPropertyDescriptor(rawScopes, String(index))?.value as string))) return undefined;
  return Object.freeze({ schema_version: 1, source_ref, source_mode,
    scopes: Object.freeze([...rawScopes]) as PushPullInteractionInput["scopes"] });
}

function decision(value: unknown): PushPullDecisionInput | undefined {
  if (!dataRecord(value) || !exact(value,
    ["action", "idempotency_key", "conflict_decisions"], ["scan_overrides"])) return undefined;
  const action = valueAt(value, "action");
  const idempotency_key = valueAt(value, "idempotency_key");
  const rawChoices = valueAt(value, "conflict_decisions");
  if ((action !== "continue" && action !== "review" && action !== "stop") ||
      !text(idempotency_key) || !denseArray(rawChoices)) return undefined;
  const conflict_decisions: PushPullDecisionInput["conflict_decisions"][number][] = [];
  for (let index = 0; index < rawChoices.length; index += 1) {
    const choice = Object.getOwnPropertyDescriptor(rawChoices, String(index))?.value;
    if (!dataRecord(choice) || !exact(choice, ["path", "resolution"],
      ["source_artifact_id", "source_project_version"])) return undefined;
    const path = valueAt(choice, "path");
    const resolution = valueAt(choice, "resolution");
    const source_artifact_id = valueAt(choice, "source_artifact_id");
    const source_project_version = valueAt(choice, "source_project_version");
    if (!text(path) || !resolutions.has(resolution as string) ||
        (source_artifact_id !== undefined && !text(source_artifact_id)) ||
        (source_project_version !== undefined && !text(source_project_version))) return undefined;
    conflict_decisions.push(Object.freeze({ path,
      resolution: resolution as "keep_local" | "accept_remote" | "skip",
      ...(source_artifact_id === undefined ? {} : { source_artifact_id }),
      ...(source_project_version === undefined ? {} : { source_project_version }) }));
  }
  const rawOverrides = valueAt(value, "scan_overrides");
  if (rawOverrides === undefined) return Object.freeze({ action, idempotency_key,
    conflict_decisions: Object.freeze(conflict_decisions) });
  if (!denseArray(rawOverrides)) return undefined;
  const scan_overrides: NonNullable<PushPullDecisionInput["scan_overrides"]>[number][] = [];
  for (let index = 0; index < rawOverrides.length; index += 1) {
    const override = Object.getOwnPropertyDescriptor(rawOverrides, String(index))?.value;
    if (!dataRecord(override) || !exact(override, ["finding_fingerprint", "actor", "reason"])) return undefined;
    const finding_fingerprint = valueAt(override, "finding_fingerprint");
    const actor = valueAt(override, "actor");
    const reason = valueAt(override, "reason");
    if (!text(finding_fingerprint) || !text(actor) || !text(reason)) return undefined;
    scan_overrides.push(Object.freeze({ finding_fingerprint, actor, reason }));
  }
  return Object.freeze({ action, idempotency_key,
    conflict_decisions: Object.freeze(conflict_decisions),
    scan_overrides: Object.freeze(scan_overrides) });
}

type Method = (...args: unknown[]) => unknown;
function method(value: unknown, name: string): Method | undefined {
  if (value === null || typeof value !== "object") return undefined;
  try {
    let owner: object | null = value;
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor !== undefined) return "value" in descriptor && typeof descriptor.value === "function"
        ? descriptor.value as Method : undefined;
      owner = Object.getPrototypeOf(owner) as object | null;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function dependency(value: unknown, key: string): unknown {
  if (!dataRecord(value)) throw new PushPullCliAdapterError("PUSH_PULL_CLI_DEPENDENCY_INVALID");
  return valueAt(value, key);
}

const noRetry = Object.freeze({ retryable: false, reason_code: null });

export function createPushPullCliPort(dependencies: PushPullCliDependencies): PushPullCliPort {
  const orchestration = dependency(dependencies, "orchestration") as PushPullOrchestration | undefined;
  const archive = dependency(dependencies, "archive") as ArchiveRemoteAdapter | undefined;
  const buildPushPreview = method(orchestration, "buildPushPreview");
  const buildPullPreview = method(orchestration, "buildPullPreview");
  const confirmPush = method(orchestration, "confirmPush");
  const resolvePull = method(orchestration, "resolvePull");
  const executePush = method(orchestration, "executePush");
  const executePull = method(orchestration, "executePull");
  const publishClaim = method(archive, "publishClaim");
  const declineUpload = method(archive, "declineUpload");
  if (orchestration !== undefined && [buildPushPreview, buildPullPreview, confirmPush, resolvePull,
    executePush, executePull].some((candidate) => candidate === undefined)) {
    throw new PushPullCliAdapterError("PUSH_PULL_CLI_DEPENDENCY_INVALID");
  }
  if (archive !== undefined && (publishClaim === undefined || declineUpload === undefined)) {
    throw new PushPullCliAdapterError("PUSH_PULL_CLI_DEPENDENCY_INVALID");
  }
  const confirmations = new Map<string, Readonly<{
    direction: PushPullDirection;
    preview_hash: string;
    request_identity: string;
  }>>();

  return Object.freeze({
    async dispatch(rawRequest: unknown): Promise<PushPullCliResult> {
      const request = trySnapshotInput(rawRequest);
      if (!dataRecord(request) || valueAt(request, "schema_version") !== 1) {
        throw new PushPullCliAdapterError("PUSH_PULL_CLI_INPUT_INVALID");
      }
      const operation = valueAt(request, "operation");
      if (operation === "preview") {
        if (!exact(request, ["schema_version", "operation", "direction", "interaction"])) {
          throw new PushPullCliAdapterError("PUSH_PULL_CLI_INPUT_INVALID");
        }
        const direction = valueAt(request, "direction");
        const input = interaction(valueAt(request, "interaction"));
        if (!directions.has(direction as string) || input === undefined) {
          throw new PushPullCliAdapterError("PUSH_PULL_CLI_INPUT_INVALID");
        }
        const target = direction === "push" ? buildPushPreview : buildPullPreview;
        if (target === undefined) throw new PushPullCliAdapterError("PUSH_PULL_CLI_UNAVAILABLE", true);
        const rawResult = await target.call(orchestration, input);
        const result = readPushPullPreviewOutput(rawResult, direction as PushPullDirection, input);
        if (result === undefined) throw new PushPullCliAdapterError("PUSH_PULL_CLI_OUTPUT_INVALID");
        return Object.freeze({ schema_version: 1, operation, direction: direction as PushPullDirection,
          retry: noRetry, result });
      }
      if (operation === "confirm") {
        if (!exact(request,
          ["schema_version", "operation", "direction", "preview_hash", "decision"])) {
          throw new PushPullCliAdapterError("PUSH_PULL_CLI_INPUT_INVALID");
        }
        const direction = valueAt(request, "direction");
        const preview_hash = valueAt(request, "preview_hash");
        const input = decision(valueAt(request, "decision"));
        if (!directions.has(direction as string) || !text(preview_hash) || input === undefined) {
          throw new PushPullCliAdapterError("PUSH_PULL_CLI_INPUT_INVALID");
        }
        const target = direction === "push" ? confirmPush : resolvePull;
        if (target === undefined) throw new PushPullCliAdapterError("PUSH_PULL_CLI_UNAVAILABLE", true);
        const rawResult = await target.call(orchestration, preview_hash, input);
        const result = readPushPullDecisionOutput(rawResult, direction as PushPullDirection, preview_hash, input);
        if (result === undefined) throw new PushPullCliAdapterError("PUSH_PULL_CLI_OUTPUT_INVALID");
        if (result.status === "confirmed") {
          const binding = Object.freeze({ direction: direction as PushPullDirection, preview_hash,
            request_identity: JSON.stringify({ direction, preview_hash, decision: input }) });
          const prior = confirmations.get(result.confirmation_id);
          if (prior !== undefined && (prior.direction !== binding.direction ||
              prior.preview_hash !== binding.preview_hash ||
              prior.request_identity !== binding.request_identity)) {
            throw new PushPullCliAdapterError("PUSH_PULL_CLI_OUTPUT_INVALID");
          }
          confirmations.set(result.confirmation_id, binding);
        }
        return Object.freeze({ schema_version: 1, operation, direction: direction as PushPullDirection,
          retry: noRetry, result });
      }
      if (operation === "execute") {
        if (!exact(request,
          ["schema_version", "operation", "direction", "confirmation_id"])) {
          throw new PushPullCliAdapterError("PUSH_PULL_CLI_INPUT_INVALID");
        }
        const direction = valueAt(request, "direction");
        const confirmation_id = valueAt(request, "confirmation_id");
        if (!directions.has(direction as string) || !text(confirmation_id)) {
          throw new PushPullCliAdapterError("PUSH_PULL_CLI_INPUT_INVALID");
        }
        const binding = confirmations.get(confirmation_id);
        if (binding === undefined || binding.direction !== direction) {
          throw new PushPullCliAdapterError("PUSH_PULL_CLI_INPUT_INVALID");
        }
        const target = direction === "push" ? executePush : executePull;
        if (target === undefined) throw new PushPullCliAdapterError("PUSH_PULL_CLI_UNAVAILABLE", true);
        const rawResult = await target.call(orchestration, confirmation_id);
        const result = readPushPullExecutionOutput(rawResult, direction as PushPullDirection);
        if (result === undefined || result.preview_hash !== binding.preview_hash) {
          throw new PushPullCliAdapterError("PUSH_PULL_CLI_OUTPUT_INVALID");
        }
        const reason_code = result.sync_receipt.reason_code ?? null;
        return Object.freeze({ schema_version: 1, operation, direction: direction as PushPullDirection,
          verification: Object.freeze({ status: "verified" as const, preview_hash: result.preview_hash }),
          retry: Object.freeze({ retryable: result.status === "retryable", reason_code }), result });
      }
      if (operation === "archive_publish") {
        if (!exact(request,
          ["schema_version", "operation", "claim", "source_ref", "retention_policy"])) {
          throw new PushPullCliAdapterError("PUSH_PULL_CLI_INPUT_INVALID");
        }
        const normalized = normalizeArchiveRemoteRequest({
          schema_version: 1,
          claim: valueAt(request, "claim"),
          source_ref: valueAt(request, "source_ref"),
          retention_policy: valueAt(request, "retention_policy")
        });
        if (!normalized.ok || normalized.readiness !== "ready") {
          throw new PushPullCliAdapterError("PUSH_PULL_CLI_INPUT_INVALID");
        }
        if (publishClaim === undefined) throw new PushPullCliAdapterError("PUSH_PULL_CLI_UNAVAILABLE", true);
        const rawResult = await publishClaim.call(archive, normalized.claim, normalized.source_ref,
          normalized.retention_policy);
        const result = snapshotArchiveRemotePublishResult(rawResult, normalized.claim,
          normalized.retention_policy);
        if (result === undefined) throw new PushPullCliAdapterError("PUSH_PULL_CLI_OUTPUT_INVALID");
        const retryable = result.outcome === "retry_scheduled";
        const reason_code = result.outcome === "stored" ? null : result.reason_code;
        return Object.freeze({ schema_version: 1, operation,
          retry: Object.freeze({ retryable, reason_code }), result });
      }
      throw new PushPullCliAdapterError("PUSH_PULL_CLI_INPUT_INVALID");
    }
  });
}
