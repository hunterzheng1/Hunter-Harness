import { isProxy } from "node:util/types";

import { canonicalJson } from "@hunter-harness/contracts";

import { sha256Bytes } from "../../fs/hash.js";
import { discriminateTrustedAsyncResult } from "../../trusted-async-result/index.js";
import type {
  PlanDurablePublicationBaseline, PlanDurablePublicationCommitInput, PlanDurablePublicationLookupInput,
  PlanDurablePublicationEventDescriptor, PlanDurablePublicationModule, PlanDurablePublicationPort, PlanDurablePublicationPortResult,
  PlanDurablePublicationReceipt, PlanDurablePublicationResult, PlanDurablePublicationRollbackInput,
  PlanDurablePublicationSha256
} from "./types.js";

const SHA = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[a-z][a-z0-9_.:-]{0,159}$/u;
const RECEIPT_ID = /^plan_durable_publication_receipt:[a-f0-9]{64}$/u;
const DURABLE_EVENT_REF = /^(?:plan_event:[a-f0-9]{64}|audit_event:sha256:[a-f0-9]{64})$/u;
const PATHS = (changeKey: string): readonly string[] => [
  "plans/" + changeKey + "-design.md", "plans/" + changeKey + "-plan.md",
  "plans/" + changeKey + "-test-scenarios.md", "plans/" + changeKey + "-implementation-detail.md",
  "meta/gate-policy.json", "meta/worktree.json", "meta/implementation-checkpoints.json", "meta/scenario-manifest.json"
];
function canonicalOwnershipPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.trim() !== value ||
      value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/u.test(value) || value.includes("\\") ||
      [...value].some((char) => (char.codePointAt(0) ?? 0) <= 0x1f || (char.codePointAt(0) ?? 0) === 0x7f)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function hash(value: unknown): PlanDurablePublicationSha256 {
  return sha256Bytes(canonicalJson(value)) as PlanDurablePublicationSha256;
}
function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return keys.length >= required.length && required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}
// 上限对齐发布载荷边界：单 payload ≤ 2MB（bytes 逐字节展开 ≤ 2M 元素），
// 八 payload 合计 ≤ 16M 节点/字符。该边界位于模块内部（renderer 产出 plan），
// 超限仍 fail closed——真实规划文档（5-50KB）远低于此界。
const SNAPSHOT_MAX_NODES = 16_000_000;
const SNAPSHOT_MAX_STRINGS = 16_000_000;
const SNAPSHOT_MAX_ARRAY_LENGTH = 2_000_000;

function snapshot(input: unknown): unknown {
  const active = new WeakSet<object>();
  let nodes = 0; let strings = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("number"); return value; }
    if (typeof value === "string") { strings += value.length; if (strings > SNAPSHOT_MAX_STRINGS) throw new Error("string"); return value; }
    if (typeof value !== "object" || isProxy(value) || depth > 64 || ++nodes > SNAPSHOT_MAX_NODES || active.has(value)) throw new Error("hostile");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("prototype");
    active.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key === "symbol")) throw new Error("symbol");
      for (const key of keys as string[]) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined ||
            (key !== "length" && descriptor.enumerable !== true)) throw new Error("descriptor");
      }
      if (array) {
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > SNAPSHOT_MAX_ARRAY_LENGTH ||
            keys.length !== (length as number) + 1) throw new Error("array");
        const result: unknown[] = [];
        for (let index = 0; index < (length as number); index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor)) throw new Error("sparse");
          result.push(copy(descriptor.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, unknown> = {};
      for (const key of keys as string[]) result[key] = copy((descriptors[key] as PropertyDescriptor).value, depth + 1);
      return result;
    } finally { active.delete(value); }
  };
  return copy(input, 0);
}
function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value &&
    ![...value].some((char) => (char.codePointAt(0) ?? 0) <= 0x1f || (char.codePointAt(0) ?? 0) === 0x7f);
}
function time(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function payloadDescriptor(value: unknown): boolean {
  return record(value) && exact(value, ["path", "artifact_type", "format", "classification", "byte_length",
    "serialized_sha256", "semantic_content_hash"]) && text(value.path, 512) && text(value.artifact_type, 160) &&
    ["markdown", "json"].includes(String(value.format)) &&
    ["human_truth", "machine_derived", "compatibility_derived"].includes(String(value.classification)) &&
    Number.isSafeInteger(value.byte_length) && (value.byte_length as number) >= 0 &&
    typeof value.serialized_sha256 === "string" && SHA.test(value.serialized_sha256) &&
    typeof value.semantic_content_hash === "string" && SHA.test(value.semantic_content_hash);
}
function validPlan(value: unknown): value is PlanDurablePublicationCommitInput["plan"] {
  if (!record(value) || !exact(value, ["schema_version", "change_key", "publication_intent_id", "manifest_hash",
    "manifest", "approval_receipt_ref", "artifact_derivation_receipt_refs", "ownership_paths", "payloads"]) ||
      value.schema_version !== 1 || !text(value.change_key, 160) || !ID.test(value.change_key) ||
      !text(value.publication_intent_id) || !ID.test(value.publication_intent_id) || typeof value.manifest_hash !== "string" ||
       !SHA.test(value.manifest_hash) || !record(value.manifest) || !exact(value.manifest,
         ["schema_version", "change_key", "approval_receipt_ref", "artifact_derivation_receipt_refs", "ownership_paths", "entries"]) ||
       value.manifest.schema_version !== 1 ||
      value.manifest.change_key !== value.change_key || value.manifest.approval_receipt_ref !== value.approval_receipt_ref ||
      !text(value.approval_receipt_ref, 512) || !Array.isArray(value.artifact_derivation_receipt_refs) ||
      value.artifact_derivation_receipt_refs.length !== 3 || value.artifact_derivation_receipt_refs.some((item) => typeof item !== "string" || !SHA.test(item)) ||
       !Array.isArray(value.ownership_paths) || value.ownership_paths.some((item) => !canonicalOwnershipPath(item)) ||
      !Array.isArray(value.payloads) || value.payloads.length !== 8) return false;
  const paths = PATHS(value.change_key);
  const payloads = value.payloads as readonly Record<string, unknown>[];
  if (payloads.some((item) => !record(item) || !exact(item, ["path", "artifact_type", "format", "classification", "serialized_content",
    "bytes", "byte_length", "serialized_sha256", "semantic_content_hash"]) || !payloadDescriptor(Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== "serialized_content" && key !== "bytes"))) ||
      typeof item.serialized_content !== "string" || !Array.isArray(item.bytes) ||
      item.byte_length !== item.bytes.length || item.byte_length !== Buffer.byteLength(item.serialized_content, "utf8") ||
      item.bytes.some((byte) => !Number.isSafeInteger(byte) || (byte as number) < 0 || (byte as number) > 255) ||
      sha256Bytes(item.serialized_content) !== item.serialized_sha256 ||
      item.bytes.some((byte, index) => byte !== Buffer.from(item.serialized_content as string, "utf8")[index]))) return false;
  if (payloads.map((item) => item.path).join("\u0000") !== paths.join("\u0000")) return false;
   if (!Array.isArray(value.manifest.artifact_derivation_receipt_refs) || value.manifest.artifact_derivation_receipt_refs.length !== 3 ||
       value.manifest.artifact_derivation_receipt_refs.some((item) => typeof item !== "string" || !SHA.test(item)) ||
       !Array.isArray(value.manifest.ownership_paths) || value.manifest.ownership_paths.some((item) => !canonicalOwnershipPath(item)) ||
       !Array.isArray(value.manifest.entries) || value.manifest.entries.length !== 8 ||
      value.manifest.entries.some((item) => !payloadDescriptor(item)) ||
      hash(value.manifest.entries) !== hash(payloads.map((item) => Object.fromEntries(Object.entries(item)
        .filter(([key]) => key !== "serialized_content" && key !== "bytes")))) ||
      hash(value.manifest) !== value.manifest_hash ||
      value.publication_intent_id !== "plan_publication:" + value.manifest_hash.slice(7)) return false;
  const ownership = value.ownership_paths as readonly string[];
  return ownership.join("\u0000") === [...new Set(ownership)].sort().join("\u0000") &&
    hash(value.manifest.artifact_derivation_receipt_refs) === hash(value.artifact_derivation_receipt_refs) &&
    hash(value.manifest.ownership_paths) === hash(value.ownership_paths);
}
function validBaseline(value: unknown): value is PlanDurablePublicationBaseline {
  if (!record(value) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0) return false;
  if (value.state === "absent") return exact(value, ["state", "manifest_hash", "generation"]) && value.manifest_hash === null && value.generation === 0;
  return value.state === "present" && exact(value, ["state", "manifest_hash", "generation"]) &&
    typeof value.manifest_hash === "string" && SHA.test(value.manifest_hash) && (value.generation as number) > 0;
}
function validReceipt(value: unknown): value is PlanDurablePublicationReceipt {
  if (!record(value) || !exact(value, ["schema_version", "receipt_id", "operation_id", "idempotency_key", "project_id", "change_key",
    "publication_intent_id", "plan_hash", "previous_manifest_hash", "manifest_hash", "previous_generation", "generation", "modified_paths",
    "preserved_paths", "event_id", "committed_at"], ["rollback_of_operation_id"]) || value.schema_version !== 1 ||
    typeof value.receipt_id !== "string" || !RECEIPT_ID.test(value.receipt_id) || !text(value.operation_id) ||
    !text(value.idempotency_key) || !text(value.project_id) || !text(value.change_key) || !text(value.publication_intent_id) || typeof value.plan_hash !== "string" || !SHA.test(value.plan_hash) ||
    !(value.previous_manifest_hash === null || typeof value.previous_manifest_hash === "string" && SHA.test(value.previous_manifest_hash)) ||
    typeof value.manifest_hash !== "string" || !SHA.test(value.manifest_hash) || !Number.isSafeInteger(value.previous_generation) ||
    (value.previous_generation as number) < 0 || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0 ||
    !Array.isArray(value.modified_paths) || !Array.isArray(value.preserved_paths) || value.modified_paths.some((item) => typeof item !== "string") ||
    value.preserved_paths.some((item) => typeof item !== "string") || typeof value.event_id !== "string" || !DURABLE_EVENT_REF.test(value.event_id) || !time(value.committed_at) ||
    (value.rollback_of_operation_id !== undefined && !text(value.rollback_of_operation_id)) ||
    (value.previous_generation === 0 ? value.previous_manifest_hash !== null : value.previous_manifest_hash === null)) return false;
  const rollback = value.rollback_of_operation_id !== undefined;
  if (rollback && (value.publication_intent_id !== "rollback:" + value.manifest_hash ||
      (value.generation as number) < 1 || (value.generation as number) >= (value.previous_generation as number))) return false;
  if (!rollback && (value.publication_intent_id !== "plan_publication:" + value.manifest_hash.slice(7) ||
      (value.generation as number) !== (value.previous_generation as number) + 1)) return false;
  const expected = PATHS(value.change_key);
  const modified = value.modified_paths as readonly string[];
  const preserved = value.preserved_paths as readonly string[];
  if (modified.some((path) => !expected.includes(path)) || preserved.some((path) => !expected.includes(path)) ||
      new Set(modified).size !== modified.length || new Set(preserved).size !== preserved.length ||
      modified.some((path) => preserved.includes(path)) ||
      new Set([...modified, ...preserved]).size !== expected.length ||
      [...new Set([...modified, ...preserved])].sort().join("\u0000") !== [...expected].sort().join("\u0000")) return false;
  const { receipt_id: ignored, ...body } = value;
  return ignored === "plan_durable_publication_receipt:" + hash(body).slice(7);
}
function ownMethod(port: unknown, name: "publish" | "lookup"): (...args: readonly unknown[]) => unknown {
  if (port === null || (typeof port !== "object" && typeof port !== "function") || isProxy(port)) throw new Error("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
  let current: object | null = port as object;
  while (current !== null) {
    if (isProxy(current)) throw new Error("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function" || isProxy(descriptor.value)) throw new Error("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
      return (...args) => Reflect.apply(descriptor.value as (...values: readonly unknown[]) => unknown, port, args);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new Error("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
}
async function call(method: (...args: readonly unknown[]) => unknown, input: unknown): Promise<unknown> {
  let raw: unknown;
  try { raw = method(input); } catch { throw new Error("PLAN_DURABLE_PUBLICATION_PORT_TRANSPORT"); }
  const trusted = discriminateTrustedAsyncResult(raw);
  if (trusted === undefined) throw new Error("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
  let resolved: unknown;
  try { resolved = trusted.kind === "sync" ? trusted.value : await trusted.promise; }
  catch { throw new Error("PLAN_DURABLE_PUBLICATION_PORT_TRANSPORT"); }
  try { return snapshot(resolved); } catch { throw new Error("PLAN_DURABLE_PUBLICATION_PORT_INVALID"); }
}
function parsePort(value: unknown, identity: PlanDurablePublicationLookupInput, baseline?: PlanDurablePublicationBaseline): PlanDurablePublicationPortResult {
  if (!record(value) || !exact(value, ["state", "receipt"]) ||
      !["committed", "replayed", "unknown", "baseline_conflict", "idempotency_conflict"].includes(String(value.state))) throw new Error("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
  if (value.state === "unknown" || value.state === "baseline_conflict" || value.state === "idempotency_conflict") {
    if (value.receipt !== null) throw new Error("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
    return freeze(value as PlanDurablePublicationPortResult);
  }
  const receipt = value.receipt;
  if (!validReceipt(receipt) || receipt.operation_id !== identity.operation_id || receipt.idempotency_key !== identity.idempotency_key ||
      receipt.project_id !== identity.project_id || receipt.change_key !== identity.change_key ||
      receipt.publication_intent_id !== identity.publication_intent_id ||
      receipt.plan_hash !== identity.plan_hash || receipt.manifest_hash !== identity.manifest_hash) {
    throw new Error("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
  }
  if (baseline !== undefined && (receipt.previous_manifest_hash !== (baseline.state === "absent" ? null : baseline.manifest_hash) ||
      receipt.previous_generation !== baseline.generation)) throw new Error("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
  return freeze(value as PlanDurablePublicationPortResult);
}
function planHash(plan: PlanDurablePublicationCommitInput["plan"]): PlanDurablePublicationSha256 { return hash(plan); }
function identityOf(input: PlanDurablePublicationCommitInput): PlanDurablePublicationLookupInput {
  return { schema_version: 1, operation_id: input.operation_id, idempotency_key: input.idempotency_key, project_id: input.project_id,
    change_key: input.change_key, publication_intent_id: input.plan.publication_intent_id,
    plan_hash: planHash(input.plan), manifest_hash: input.plan.manifest_hash as PlanDurablePublicationSha256 };
}
function commitInput(input: unknown): PlanDurablePublicationCommitInput | "legacy" {
  let value: unknown; try { value = snapshot(input); } catch { throw new Error("PLAN_DURABLE_PUBLICATION_INPUT_INVALID"); }
  if (!record(value)) throw new Error("PLAN_DURABLE_PUBLICATION_INPUT_INVALID");
  if (value.finalization !== undefined && record(value.finalization) &&
      (value.finalization.finalizer_action !== undefined || value.finalization.status !== undefined)) return "legacy";
  if (!exact(value, ["schema_version", "operation_id", "idempotency_key", "project_id", "change_key", "expected_baseline", "plan"], ["finalization"]) ||
      value.schema_version !== 1 || !text(value.operation_id) || !ID.test(value.operation_id) || !text(value.idempotency_key) ||
      !text(value.project_id) || !text(value.change_key) || !validBaseline(value.expected_baseline) || !validPlan(value.plan) ||
      value.plan.change_key !== value.change_key) throw new Error("PLAN_DURABLE_PUBLICATION_INPUT_INVALID");
  return freeze(value as unknown as PlanDurablePublicationCommitInput);
}
function lookupInput(input: unknown): PlanDurablePublicationLookupInput {
  let value: unknown; try { value = snapshot(input); } catch { throw new Error("PLAN_DURABLE_PUBLICATION_INPUT_INVALID"); }
  if (!record(value) || !exact(value, ["schema_version", "operation_id", "idempotency_key", "project_id", "change_key", "publication_intent_id", "plan_hash", "manifest_hash"]) ||
      value.schema_version !== 1 || !text(value.operation_id) || !text(value.idempotency_key) || !text(value.project_id) ||
      !text(value.change_key) || !text(value.publication_intent_id) || typeof value.plan_hash !== "string" || !SHA.test(value.plan_hash) || typeof value.manifest_hash !== "string" || !SHA.test(value.manifest_hash)) throw new Error("PLAN_DURABLE_PUBLICATION_INPUT_INVALID");
  return freeze(value as unknown as PlanDurablePublicationLookupInput);
}
function result(value: PlanDurablePublicationPortResult, operationId: string): PlanDurablePublicationResult {
  if (value.state === "committed" || value.state === "replayed") {
    const event: PlanDurablePublicationEventDescriptor = {
      schema_version: 1, event_kind: "publication_durable", operation_id: operationId,
      change_key: value.receipt.change_key, publication_intent_id: value.receipt.publication_intent_id,
      receipt_id: value.receipt.receipt_id, generation: value.receipt.generation, occurred_at: value.receipt.committed_at
    };
    return freeze({ ok: true, outcome: value.state, receipt: value.receipt, event_allowed: true, event });
  }
  return freeze({ ok: false, outcome: value.state, receipt: null, operation_id: operationId });
}
function legacy(operationId: string): PlanDurablePublicationResult {
  return freeze({ ok: false, outcome: "legacy_read_only", receipt: null, operation_id: operationId });
}

export function verifyDurablePublicationReceipt(input: unknown): boolean {
  try { return validReceipt(snapshot(input)); } catch { return false; }
}
export function createDurablePlanPublicationModule(port: PlanDurablePublicationPort): PlanDurablePublicationModule {
  const publishPort = ownMethod(port, "publish"); const lookupPort = ownMethod(port, "lookup");
  const lookup = async (identity: PlanDurablePublicationLookupInput, baseline?: PlanDurablePublicationBaseline): Promise<PlanDurablePublicationResult> =>
    result(parsePort(await call(lookupPort, identity), identity, baseline), identity.operation_id);
  return freeze({
    async publish(rawInput: unknown): Promise<PlanDurablePublicationResult> {
      const input = commitInput(rawInput); if (input === "legacy") return legacy("legacy");
      const identity = identityOf(input);
      let rawResult: unknown;
      try { rawResult = await call(publishPort, input); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "PLAN_DURABLE_PUBLICATION_PORT_TRANSPORT") throw error;
        try { return await lookup(identity, input.expected_baseline); } catch { throw error; }
      }
      const parsed = parsePort(rawResult, identity, input.expected_baseline);
      return parsed.state === "unknown" ? lookup(identity, input.expected_baseline) : result(parsed, input.operation_id);
    },
    async lookup(rawInput: unknown): Promise<PlanDurablePublicationResult> {
      const identity = lookupInput(rawInput); return lookup(identity);
    },
    async rollback(rawInput: unknown): Promise<PlanDurablePublicationResult> {
      let value: unknown; try { value = snapshot(rawInput); } catch { throw new Error("PLAN_DURABLE_PUBLICATION_INPUT_INVALID"); }
      if (!record(value) || !exact(value, ["schema_version", "operation_id", "idempotency_key", "project_id", "change_key",
        "expected_baseline", "target_manifest_hash", "target_generation", "plan_hash"]) || value.schema_version !== 1 ||
          !text(value.operation_id) || !text(value.idempotency_key) || !text(value.project_id) || !text(value.change_key) ||
          !validBaseline(value.expected_baseline) || value.expected_baseline.state === "absent" ||
          typeof value.target_manifest_hash !== "string" || !SHA.test(value.target_manifest_hash) || !Number.isSafeInteger(value.target_generation) ||
          (value.target_generation as number) < 1 || (value.target_generation as number) >= (value.expected_baseline.generation as number) ||
          typeof value.plan_hash !== "string" || !SHA.test(value.plan_hash)) throw new Error("PLAN_DURABLE_PUBLICATION_INPUT_INVALID");
      const request = value as unknown as PlanDurablePublicationRollbackInput;
      const identity: PlanDurablePublicationLookupInput = { schema_version: 1, operation_id: request.operation_id, idempotency_key: request.idempotency_key,
        project_id: request.project_id, change_key: request.change_key, publication_intent_id: "rollback:" + request.target_manifest_hash,
        plan_hash: request.plan_hash, manifest_hash: request.target_manifest_hash };
      const parsed = parsePort(await call(publishPort, request), identity, request.expected_baseline);
      if (parsed.state === "unknown") return lookup(identity, request.expected_baseline);
      if ((parsed.state === "committed" || parsed.state === "replayed") && parsed.receipt.generation !== request.target_generation) throw new Error("PLAN_DURABLE_PUBLICATION_PORT_INVALID");
      return result(parsed, request.operation_id);
    },
    readReceipt(input: unknown) {
      try {
        const value = snapshot(input);
        if (record(value) && (value.finalizer_action !== undefined || value.status !== undefined)) return freeze({ ok: true as const, mode: "legacy_read_only" as const, source_schema_version: 1 as const });
        if (record(value) && value.schema_version === 0) return freeze({ ok: true as const, mode: "legacy_read_only" as const, source_schema_version: 0 as const });
        return validReceipt(value) ? freeze({ ok: true as const, mode: "current" as const, value }) :
          freeze({ ok: false as const, reason_code: "PLAN_DURABLE_PUBLICATION_RECEIPT_INVALID" as const });
      } catch { return freeze({ ok: false as const, reason_code: "PLAN_DURABLE_PUBLICATION_RECEIPT_INVALID" as const }); }
    }
  });
}
export function publishDurablePlanPublication(port: PlanDurablePublicationPort, input: unknown): Promise<PlanDurablePublicationResult> {
  return createDurablePlanPublicationModule(port).publish(input);
}
