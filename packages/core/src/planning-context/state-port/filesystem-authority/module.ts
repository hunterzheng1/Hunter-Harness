import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isProxy } from "node:util/types";

import { canonicalJson } from "@hunter-harness/contracts";

import {
  createLocalFilesystemAuthorityGeneration,
  ensureLocalFilesystemAuthorityDirectory,
  verifyLocalFilesystemAuthorityFile,
  withLocalFilesystemAuthorityLock,
  writeLocalFilesystemAuthorityPointer
} from "../../../codebase/map-v2/publication-transaction/filesystem.js";
import { snapshotAggregateIdentity, type AggregateIdentity, type DurableCommitResult } from "../../../durable-state-primitives/index.js";
import { stableHash } from "../../stable.js";
import {
  InMemoryPlanningContextStateStore,
  normalizePlanningContextStateLegacy,
  snapshotPlanningContextEventDeliveryAckInput,
  snapshotPlanningContextStateCommitInput
} from "../module.js";
import type {
  PlanningContextEventDeliveryAckInput,
  PlanningContextEventDeliveryRecord,
  PlanningContextStateAuditEvent,
  PlanningContextStateAuditPage,
  PlanningContextStateCommitInput,
  PlanningContextStateCurrent,
  PlanningContextStateLegacyView
} from "../types.js";
import type {
  PlanningContextFilesystemAuthorityErrorCode,
  PlanningContextFilesystemAuthorityOptions,
  PlanningContextFilesystemStatePort
} from "./types.js";

const CHANGE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const GENERATION = /^planning_context_generation:[a-f0-9]{64}$/u;
const MAX_TRANSITIONS = 10_000;
const MAX_POINTER_BYTES = 16 * 1024;
const MAX_GENERATION_BYTES = 64 * 1024 * 1024;
const MAX_HASH_DEPTH = 32;
const MAX_HASH_NODES = 1_000_000;
const MAX_HASH_STRING_UNITS = 32 * 1024 * 1024;
const MAX_HASH_ARRAY_LENGTH = MAX_TRANSITIONS;

interface StoredCommand {
  readonly input: PlanningContextStateCommitInput;
  readonly receipt: NonNullable<DurableCommitResult["receipt"]>;
}

interface GenerationWire {
  readonly schema_version: 1;
  readonly record_kind: "planning_context_state_generation";
  readonly aggregate: AggregateIdentity;
  readonly revision: number;
  readonly current: PlanningContextStateCurrent;
  readonly audit: readonly PlanningContextStateAuditEvent[];
  readonly deliveries: readonly PlanningContextEventDeliveryRecord[];
  readonly commands: readonly StoredCommand[];
  readonly acknowledgements: readonly PlanningContextEventDeliveryAckInput[];
}

interface PointerWire {
  readonly schema_version: 1;
  readonly record_kind: "planning_context_state_pointer";
  readonly aggregate: AggregateIdentity;
  readonly revision: number;
  readonly generation_id: `planning_context_generation:${string}`;
  readonly generation_hash: `sha256:${string}`;
}

interface Loaded {
  readonly store: InMemoryPlanningContextStateStore;
  readonly generation: GenerationWire | null;
  readonly legacy: PlanningContextStateLegacyView | null;
}

export class PlanningContextFilesystemAuthorityError extends Error {
  constructor(readonly code: PlanningContextFilesystemAuthorityErrorCode) { super(code); this.name = "PlanningContextFilesystemAuthorityError"; }
}

function fail(code: PlanningContextFilesystemAuthorityErrorCode): never { throw new PlanningContextFilesystemAuthorityError(code); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function snapshotHashInput(value: unknown, code: PlanningContextFilesystemAuthorityErrorCode,
  maxBytes: number): unknown {
  const seen = new WeakSet<object>(); let nodes = 0; let stringUnits = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "boolean" || input === undefined) return input;
    if (typeof input === "number") { if (!Number.isFinite(input)) fail(code); return input; }
    if (typeof input === "string") {
      stringUnits += input.length;
      if (input.length > MAX_HASH_STRING_UNITS || stringUnits > MAX_HASH_STRING_UNITS) fail(code);
      return input;
    }
    if (typeof input !== "object" || isProxy(input) || depth > MAX_HASH_DEPTH || ++nodes > MAX_HASH_NODES || seen.has(input)) fail(code);
    const array = Array.isArray(input); const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail(code);
    seen.add(input);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(input); const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string")) fail(code);
      for (const key of keys as string[]) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined ||
            (array && key === "length" ? false : descriptor.enumerable !== true)) fail(code);
      }
      if (array) {
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_HASH_ARRAY_LENGTH || keys.length !== length + 1) fail(code);
        return Array.from({ length }, (_, index) => copy((descriptors[String(index)] as PropertyDescriptor).value, depth + 1));
      }
      return Object.fromEntries((keys as string[]).map((key) =>
        [key, copy((descriptors[key] as PropertyDescriptor).value, depth + 1)]));
    } finally { seen.delete(input); }
  };
  const snapshot = copy(value, 0);
  let encoded: string;
  try { encoded = JSON.stringify(snapshot); } catch { return fail(code); }
  if (Buffer.byteLength(encoded) > maxBytes) fail(code);
  return snapshot;
}

function planningHash(value: unknown, code: PlanningContextFilesystemAuthorityErrorCode,
  maxBytes = MAX_GENERATION_BYTES): `sha256:${string}` {
  return stableHash(snapshotHashInput(value, code, maxBytes));
}
function same(left: unknown, right: unknown, code: PlanningContextFilesystemAuthorityErrorCode): boolean {
  return planningHash(left, code) === planningHash(right, code);
}
function bytes(value: unknown, code: PlanningContextFilesystemAuthorityErrorCode, maxBytes: number): string {
  return `${canonicalJson(snapshotHashInput(value, code, maxBytes))}\n`;
}
function generationFilename(generationId: string): string { return `${encodeURIComponent(generationId)}.json`; }

async function planningFilesystemCall<T>(code: PlanningContextFilesystemAuthorityErrorCode,
  work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof PlanningContextFilesystemAuthorityError) throw error;
    return fail(code);
  }
}

function snapshotOptions(value: unknown): PlanningContextFilesystemAuthorityOptions {
  if (!plain(value)) fail("PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = ["project_root", "project_identity", "before_pointer_second_read", "before_lock_reclaim"];
  if (Object.keys(descriptors).some((key) => !allowed.includes(key))) fail("PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID");
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) fail("PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID");
  }
  const projectRoot = descriptors.project_root?.value as unknown;
  const projectIdentity = descriptors.project_identity?.value as unknown;
  const beforePointerSecondRead = descriptors.before_pointer_second_read?.value as unknown;
  const beforeLockReclaim = descriptors.before_lock_reclaim?.value as unknown;
  if (typeof projectRoot !== "string" || projectRoot.length === 0 ||
      typeof projectIdentity !== "string" || projectIdentity.length === 0 || projectIdentity.length > 160 ||
      (beforePointerSecondRead !== undefined && (typeof beforePointerSecondRead !== "function" || isProxy(beforePointerSecondRead))) ||
      (beforeLockReclaim !== undefined && (typeof beforeLockReclaim !== "function" || isProxy(beforeLockReclaim)))) {
    fail("PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID");
  }
  return {
    project_root: projectRoot,
    project_identity: projectIdentity,
    ...(beforePointerSecondRead === undefined ? {} : { before_pointer_second_read: beforePointerSecondRead as () => void | Promise<void> }),
    ...(beforeLockReclaim === undefined ? {} : { before_lock_reclaim: beforeLockReclaim as () => void | Promise<void> })
  };
}

function paths(projectRoot: string, aggregate: AggregateIdentity) {
  if (!CHANGE.test(aggregate.change_key)) {
    fail("PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID");
  }
  const metaRoot = join(projectRoot, ".harness", "changes", encodeURIComponent(aggregate.change_key), "meta");
  return { meta_root: metaRoot, pointer: join(metaRoot, "planning-context.json"),
    generations: join(metaRoot, ".planning-context-generations"), lock: join(metaRoot, ".planning-context.lock") };
}

function parsePointer(value: unknown, aggregate: AggregateIdentity): PointerWire {
  if (!plain(value) || !exact(value, ["schema_version", "record_kind", "aggregate", "revision", "generation_id", "generation_hash"]) ||
      value.schema_version !== 1 || value.record_kind !== "planning_context_state_pointer" ||
      !same(value.aggregate, aggregate, "PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID") ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.generation_id !== "string" ||
      !GENERATION.test(value.generation_id) || typeof value.generation_hash !== "string" || !SHA.test(value.generation_hash)) {
    fail("PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID");
  }
  return value as unknown as PointerWire;
}

function parseJson(raw: string, code: PlanningContextFilesystemAuthorityErrorCode): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return fail(code); }
}

function allAudit(store: InMemoryPlanningContextStateStore, aggregate: AggregateIdentity): readonly PlanningContextStateAuditEvent[] {
  const events: PlanningContextStateAuditEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = store.audit(aggregate, 100, cursor);
    events.push(...page.events);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return events;
}

function allDeliveries(store: InMemoryPlanningContextStateStore, aggregate: AggregateIdentity,
  audit: readonly PlanningContextStateAuditEvent[]): readonly PlanningContextEventDeliveryRecord[] {
  return audit.map((event) => {
    const identity = planningHash({ aggregate, audit_event_id: event.event_id }, "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
    const found = store.delivery(aggregate, `planning_context_event_outbox:${identity.slice(7)}`);
    if (found === null) return fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
    return found;
  });
}

function materialize(store: InMemoryPlanningContextStateStore, aggregate: AggregateIdentity,
  commands: readonly StoredCommand[], acknowledgements: readonly PlanningContextEventDeliveryAckInput[]): GenerationWire {
  const current = store.current(aggregate);
  const audit = allAudit(store, aggregate);
  const deliveries = allDeliveries(store, aggregate, audit);
  return { schema_version: 1, record_kind: "planning_context_state_generation", aggregate,
    revision: current.revision, current, audit, deliveries, commands, acknowledgements };
}

function hydrate(value: unknown, aggregate: AggregateIdentity): { store: InMemoryPlanningContextStateStore; generation: GenerationWire } {
  if (!plain(value) || !exact(value, ["schema_version", "record_kind", "aggregate", "revision", "current", "audit", "deliveries",
    "commands", "acknowledgements"]) || value.schema_version !== 1 || value.record_kind !== "planning_context_state_generation" ||
      !same(value.aggregate, aggregate, "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID") ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
      !Array.isArray(value.audit) || !Array.isArray(value.deliveries) || !Array.isArray(value.commands) ||
      !Array.isArray(value.acknowledgements) || value.commands.length < 1 || value.commands.length > MAX_TRANSITIONS ||
      value.acknowledgements.length > MAX_TRANSITIONS) fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
  const store = new InMemoryPlanningContextStateStore();
  const commands: StoredCommand[] = [];
  for (const raw of value.commands) {
    if (!plain(raw) || !exact(raw, ["input", "receipt"])) fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
    const input = snapshotPlanningContextStateCommitInput(raw.input);
    if (!same(input.aggregate, aggregate, "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID")) fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
    const result = store.commit(input);
    if (result.outcome !== "committed" || result.receipt === null ||
        !same(result.receipt, raw.receipt, "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID")) {
      fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
    }
    commands.push({ input, receipt: result.receipt });
  }
  const acknowledgements: PlanningContextEventDeliveryAckInput[] = [];
  for (const raw of value.acknowledgements) {
    const acknowledgement = snapshotPlanningContextEventDeliveryAckInput(raw);
    if (!same(acknowledgement.aggregate, aggregate, "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID")) fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
    store.acknowledge(acknowledgement); acknowledgements.push(acknowledgement);
  }
  const expected = materialize(store, aggregate, commands, acknowledgements);
  if (!same(expected, value, "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID")) fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
  return { store, generation: expected };
}

export function createPlanningContextFilesystemStatePort(options: PlanningContextFilesystemAuthorityOptions): PlanningContextFilesystemStatePort {
  const trustedOptions = snapshotOptions(options);
  const projectRoot = resolve(trustedOptions.project_root);

  function authorityAggregate(raw: unknown): AggregateIdentity {
    let aggregate: AggregateIdentity;
    try { aggregate = snapshotAggregateIdentity(raw); } catch { return fail("PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID"); }
    if (aggregate.project_id !== trustedOptions.project_identity) fail("PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID");
    paths(projectRoot, aggregate); return aggregate;
  }

  async function readRawPointer(aggregate: AggregateIdentity): Promise<string | null> {
    const location = paths(projectRoot, aggregate);
    return planningFilesystemCall("PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID", async () => {
      await ensureLocalFilesystemAuthorityDirectory(projectRoot, location.meta_root);
      await verifyLocalFilesystemAuthorityFile(location.pointer);
      try { return await readFile(location.pointer, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    });
  }

  async function load(aggregate: AggregateIdentity): Promise<Loaded> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const first = await readRawPointer(aggregate);
      if (first === null) return { store: new InMemoryPlanningContextStateStore(), generation: null, legacy: null };
      if (Buffer.byteLength(first) > MAX_POINTER_BYTES) fail("PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID");
      const parsed = parseJson(first, "PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID");
      if (plain(parsed) && parsed.schema_version === 0) {
        let legacy: PlanningContextStateLegacyView;
        try { legacy = normalizePlanningContextStateLegacy(parsed); } catch { return fail("PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID"); }
        await trustedOptions.before_pointer_second_read?.();
        const second = await readRawPointer(aggregate);
        if (second !== first) continue;
        return { store: new InMemoryPlanningContextStateStore(), generation: null, legacy };
      }
      const pointer = parsePointer(parsed, aggregate);
      const location = paths(projectRoot, aggregate);
      await planningFilesystemCall("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID", async () =>
        ensureLocalFilesystemAuthorityDirectory(projectRoot, location.generations));
      const generationPath = join(location.generations, generationFilename(pointer.generation_id));
      const generationRaw = await planningFilesystemCall("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID", async () => {
        await verifyLocalFilesystemAuthorityFile(generationPath);
        return readFile(generationPath, "utf8");
      });
      if (Buffer.byteLength(generationRaw) > MAX_GENERATION_BYTES) fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
      const generationValue = parseJson(generationRaw, "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
      if (planningHash(generationValue, "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID") !== pointer.generation_hash ||
          pointer.generation_id !== `planning_context_generation:${pointer.generation_hash.slice(7)}`) {
        fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
      }
      let reconstructed: ReturnType<typeof hydrate>;
      try { reconstructed = hydrate(generationValue, aggregate); }
      catch { return fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID"); }
      if (reconstructed.generation.revision !== pointer.revision) fail("PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID");
      await trustedOptions.before_pointer_second_read?.();
      const second = await readRawPointer(aggregate);
      if (second !== first) continue;
      parsePointer(parseJson(second, "PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID"), aggregate);
      return { ...reconstructed, legacy: null };
    }
    return fail("PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID");
  }

  async function persist(aggregate: AggregateIdentity, generation: GenerationWire): Promise<void> {
    const location = paths(projectRoot, aggregate);
    await planningFilesystemCall("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID", async () =>
      ensureLocalFilesystemAuthorityDirectory(projectRoot, location.generations));
    const generationHash = planningHash(generation, "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
    const generationId = `planning_context_generation:${generationHash.slice(7)}` as const;
    const generationPath = join(location.generations, generationFilename(generationId));
    const generationBytes = bytes(generation, "PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID", MAX_GENERATION_BYTES);
    if (Buffer.byteLength(generationBytes) > MAX_GENERATION_BYTES) fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
    try { await createLocalFilesystemAuthorityGeneration(generationPath, generationBytes); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
      await planningFilesystemCall("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID", async () => {
        await verifyLocalFilesystemAuthorityFile(generationPath);
        if (await readFile(generationPath, "utf8") !== generationBytes) fail("PLANNING_CONTEXT_FILESYSTEM_GENERATION_INVALID");
      });
    }
    const pointer: PointerWire = { schema_version: 1, record_kind: "planning_context_state_pointer", aggregate,
      revision: generation.revision, generation_id: generationId, generation_hash: generationHash };
    await planningFilesystemCall("PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID", async () =>
      writeLocalFilesystemAuthorityPointer(location.pointer,
        bytes(pointer, "PLANNING_CONTEXT_FILESYSTEM_POINTER_INVALID", MAX_POINTER_BYTES)));
  }

  async function locked<T>(aggregate: AggregateIdentity, work: (loaded: Loaded) => Promise<T>): Promise<T> {
    const location = paths(projectRoot, aggregate);
    const authorityHash = planningHash({ project_identity: trustedOptions.project_identity,
      project_root: projectRoot, change_key: aggregate.change_key }, "PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID", MAX_POINTER_BYTES);
    try {
      const preflight = await load(aggregate);
      if (preflight.legacy !== null) fail("PLANNING_CONTEXT_FILESYSTEM_LEGACY_READ_ONLY");
      return await withLocalFilesystemAuthorityLock({ project_root: projectRoot, authority_root: location.meta_root,
        lock_path: location.lock, authority_hash: authorityHash, before_reclaim: trustedOptions.before_lock_reclaim }, async () => {
        const loaded = await load(aggregate);
        if (loaded.legacy !== null) fail("PLANNING_CONTEXT_FILESYSTEM_LEGACY_READ_ONLY");
        return work(loaded);
      });
    } catch (error) {
      if (error instanceof PlanningContextFilesystemAuthorityError) throw error;
      if (error instanceof Error && error.message.includes("LOCKED")) fail("PLANNING_CONTEXT_FILESYSTEM_LOCKED");
      return fail("PLANNING_CONTEXT_FILESYSTEM_AUTHORITY_INVALID");
    }
  }

  return {
    async commit(raw: PlanningContextStateCommitInput): Promise<DurableCommitResult> {
      const input = snapshotPlanningContextStateCommitInput(raw); const aggregate = authorityAggregate(input.aggregate);
      return locked(aggregate, async (loaded) => {
        const result = loaded.store.commit(input);
        if (result.outcome !== "committed" || result.receipt === null) return result;
        const commands = [...(loaded.generation?.commands ?? []), { input, receipt: result.receipt }];
        const generation = materialize(loaded.store, aggregate, commands, loaded.generation?.acknowledgements ?? []);
        await persist(aggregate, generation); return result;
      });
    },
    async getCurrent(raw: AggregateIdentity): Promise<PlanningContextStateCurrent> {
      const aggregate = authorityAggregate(raw); const loaded = await load(aggregate);
      if (loaded.legacy !== null) fail("PLANNING_CONTEXT_FILESYSTEM_LEGACY_READ_ONLY");
      return loaded.store.current(aggregate);
    },
    async listAudit(raw: AggregateIdentity, limit: number, cursor?: string): Promise<PlanningContextStateAuditPage> {
      const aggregate = authorityAggregate(raw); const loaded = await load(aggregate);
      if (loaded.legacy !== null) fail("PLANNING_CONTEXT_FILESYSTEM_LEGACY_READ_ONLY");
      return loaded.store.audit(aggregate, limit, cursor);
    },
    async listPendingDeliveries(raw: AggregateIdentity, limit: number): Promise<readonly PlanningContextEventDeliveryRecord[]> {
      const aggregate = authorityAggregate(raw); const loaded = await load(aggregate);
      if (loaded.legacy !== null) fail("PLANNING_CONTEXT_FILESYSTEM_LEGACY_READ_ONLY");
      return loaded.store.pending(aggregate, limit);
    },
    async getDelivery(raw: AggregateIdentity, outboxId: PlanningContextEventDeliveryRecord["outbox_id"]): Promise<PlanningContextEventDeliveryRecord | null> {
      const aggregate = authorityAggregate(raw); const loaded = await load(aggregate);
      if (loaded.legacy !== null) fail("PLANNING_CONTEXT_FILESYSTEM_LEGACY_READ_ONLY");
      return loaded.store.delivery(aggregate, outboxId);
    },
    async acknowledgeDelivery(raw: PlanningContextEventDeliveryAckInput): Promise<PlanningContextEventDeliveryRecord> {
      const input = snapshotPlanningContextEventDeliveryAckInput(raw); const aggregate = authorityAggregate(input.aggregate);
      return locked(aggregate, async (loaded) => {
        const before = loaded.store.delivery(aggregate, input.outbox_id);
        const acknowledged = loaded.store.acknowledge(input);
        if (before?.state === "acknowledged") return acknowledged;
        const acknowledgements = [...(loaded.generation?.acknowledgements ?? []), input];
        const generation = materialize(loaded.store, aggregate, loaded.generation?.commands ?? [], acknowledgements);
        await persist(aggregate, generation); return acknowledged;
      });
    },
    async readLegacy(raw: AggregateIdentity): Promise<PlanningContextStateLegacyView | null> {
      const aggregate = authorityAggregate(raw); return (await load(aggregate)).legacy;
    }
  };
}
