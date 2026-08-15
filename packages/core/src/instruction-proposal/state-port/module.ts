import { isProxy } from "node:util/types";

import {
  DurableStateBoundaryError,
  InMemoryDurableStateStore,
  snapshotAggregateIdentity,
  snapshotDurableCommitInput
} from "../../durable-state-primitives/index.js";
import { InstructionProposalError } from "../errors.js";
import { normalizeLegacyInstructionProposal } from "../legacy.js";
import type { LegacyInstructionProposalView } from "../types.js";
import {
  INSTRUCTION_PROPOSAL_STATE_RECORD_KIND,
  INSTRUCTION_PROPOSAL_STATE_STREAM_KIND,
  type InstructionProposalStateAuditPage,
  type InstructionProposalStateCommitInput,
  type InstructionProposalStateCurrent,
  type InstructionProposalStatePort
} from "./types.js";

const EVENT_KINDS: readonly string[] = ["proposal_created", "candidate_decided", "decision_batch"];

function legacyInvalid(detail: string): never {
  throw new InstructionProposalError("INSTRUCTION_LEGACY_PROPOSAL_INVALID", detail);
}

function snapshotLegacy(value: unknown): Record<string, unknown> {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let stringUnits = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      stringUnits += input.length;
      if (input.length > 16_384 || stringUnits > 65_536) legacyInvalid("legacy text is unbounded");
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) legacyInvalid("legacy number is invalid");
      return input;
    }
    if (typeof input !== "object" || isProxy(input) || depth > 16 || ++nodes > 2_048 || seen.has(input)) {
      legacyInvalid("legacy value is hostile or unbounded");
    }
    seen.add(input);
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      legacyInvalid("legacy prototype is invalid");
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) legacyInvalid("legacy symbol key");
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined ||
          descriptor.set !== undefined || (key !== "length" && descriptor.enumerable !== true)) {
        legacyInvalid("legacy accessor or hidden property");
      }
    }
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 128 ||
          keys.length !== (length as number) + 1) legacyInvalid("legacy array is invalid");
      const result: unknown[] = [];
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) legacyInvalid("legacy array is sparse");
        result.push(copy(descriptor.value, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) result[key] = copy((descriptors[key] as PropertyDescriptor).value, depth + 1);
    return result;
  };
  const snapshot = copy(value, 0);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) legacyInvalid("legacy root is invalid");
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 65_536) legacyInvalid("legacy record is too large");
  return snapshot as Record<string, unknown>;
}

function invalid(detail: string): never {
  throw new DurableStateBoundaryError(`instruction proposal state: ${detail}`);
}

function snapshotProposalCommit(input: InstructionProposalStateCommitInput): InstructionProposalStateCommitInput {
  const copy = snapshotDurableCommitInput(input);
  if (copy.stream_kind !== INSTRUCTION_PROPOSAL_STATE_STREAM_KIND || !EVENT_KINDS.includes(copy.event_kind) ||
      copy.descriptor.record_kind !== INSTRUCTION_PROPOSAL_STATE_RECORD_KIND ||
      (copy.previous_descriptor !== null && copy.previous_descriptor.record_kind !== INSTRUCTION_PROPOSAL_STATE_RECORD_KIND)) {
    invalid("record or event kind is invalid");
  }
  return copy as InstructionProposalStateCommitInput;
}

/**
 * Reference-only state adapter. Durable persistence implementations can use
 * the same port while this adapter keeps the current descriptor and audit
 * append in one durable-state-primitives commit.
 */
export class InMemoryInstructionProposalStatePort implements InstructionProposalStatePort {
  private readonly store = new InMemoryDurableStateStore();

  async commit(input: InstructionProposalStateCommitInput) {
    const safeInput = snapshotProposalCommit(input);
    return this.store.commit(safeInput);
  }

  async getCurrent(aggregate: InstructionProposalStateCommitInput["aggregate"]): Promise<InstructionProposalStateCurrent> {
    const safeAggregate = snapshotAggregateIdentity(aggregate);
    return this.store.getCurrent(safeAggregate);
  }

  async listAudit(aggregate: InstructionProposalStateCommitInput["aggregate"], limit: number, cursor?: string):
    Promise<InstructionProposalStateAuditPage> {
    const safeAggregate = snapshotAggregateIdentity(aggregate);
    const page = this.store.listAudit(safeAggregate, INSTRUCTION_PROPOSAL_STATE_STREAM_KIND, limit, cursor);
    if (page.events.some((event) => !EVENT_KINDS.includes(event.event_kind))) invalid("stored event kind is invalid");
    return page as InstructionProposalStateAuditPage;
  }
}

export function createInMemoryInstructionProposalStatePort(): InstructionProposalStatePort {
  return new InMemoryInstructionProposalStatePort();
}

export function normalizeInstructionProposalStateLegacy(input: unknown): LegacyInstructionProposalView {
  const record = snapshotLegacy(input);
  const keys = Object.keys(record);
  if (keys.length !== 4 || !["schema_version", "proposal_id", "created_at", "changes"].every((key) => Object.hasOwn(record, key)) ||
      record.schema_version !== 0 || typeof record.proposal_id !== "string" || record.proposal_id.length === 0 ||
      record.proposal_id.length > 256 || typeof record.created_at !== "string" || record.created_at.length === 0 ||
      record.created_at.length > 64 || !Array.isArray(record.changes) || record.changes.length > 128 ||
      [...record.proposal_id, ...record.created_at].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f)) {
    legacyInvalid("legacy schema is invalid");
  }
  return normalizeLegacyInstructionProposal(record);
}
