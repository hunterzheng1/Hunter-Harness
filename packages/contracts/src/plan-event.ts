import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";

export const PLAN_EVENT_PHASES = [
  "plan", "run", "test", "review", "package", "apidoc", "submit", "merge", "archive"
] as const;
export type PlanEventPhase = (typeof PLAN_EVENT_PHASES)[number];

export const PLAN_EVENT_TYPES = [
  "phase_started", "decision_recorded", "risk_found", "artifact_published",
  "validation_failed", "phase_ended"
] as const;
export type PlanEventType = (typeof PLAN_EVENT_TYPES)[number];

const identitySchema = z.string().min(1).max(160).regex(/^[a-z][a-z0-9_.:-]{0,159}$/u);
const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const eventIdSchema = z.string().regex(/^plan_event:[0-9a-f]{64}$/u);
const normalizedText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.trim() === value);
const timeSchema = z.string().refine((value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > maxDay) return false;
  const zone = match[8] as string;
  return zone === "Z" || Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59;
});

export const planEventSchema = z.object({
  schema_version: z.literal(1),
  event_id: eventIdSchema,
  lifecycle_kind: z.literal("change"),
  run_id: identitySchema,
  change_key: identitySchema,
  phase: z.enum(PLAN_EVENT_PHASES),
  attempt: z.number().int().min(1).max(1_000_000),
  type: z.enum(PLAN_EVENT_TYPES),
  producer_seq: z.number().int().min(1).max(1_000_000),
  occurred_at: timeSchema,
  idempotency_key: hashSchema,
  summary_zh: normalizedText(2_048).optional(),
  detail_ref: normalizedText(512).optional(),
  receipt_ref: normalizedText(512).optional()
}).strict();

export const planEventBundleSchema = z.object({
  schema_version: z.literal(1),
  lifecycle_kind: z.literal("change"),
  run_id: identitySchema,
  change_key: identitySchema,
  events: z.array(planEventSchema).min(1).max(4_096),
  bundle_hash: hashSchema
}).strict();

export type PlanEvent = z.infer<typeof planEventSchema>;
export type PlanEventBundle = z.infer<typeof planEventBundleSchema>;

export interface PlanEventBundleSha256Port {
  sha256(canonical_payload: string): string | Promise<string>;
}

export type PlanEventBundleReadResult =
  | { readonly ok: true; readonly mode: "current" | "terminal"; readonly source_schema_version: 1;
      readonly value: PlanEventBundle }
  | { readonly ok: false; readonly reason_code:
      | "PLAN_EVENT_SERIALIZED_JSON_REQUIRED"
      | "PLAN_EVENT_SERIALIZED_JSON_TOO_LARGE"
      | "PLAN_EVENT_VERSION_UNSUPPORTED"
      | "PLAN_EVENT_BUNDLE_INVALID" };

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function invalid(): PlanEventBundleReadResult {
  return freeze({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
}

function eventMachine(event: PlanEvent) {
  return {
    lifecycle_kind: event.lifecycle_kind,
    run_id: event.run_id,
    change_key: event.change_key,
    phase: event.phase,
    attempt: event.attempt,
    type: event.type,
    producer_seq: event.producer_seq
  };
}

function validSequence(bundle: PlanEventBundle): boolean {
  const events = bundle.events;
  if (events[0]?.type !== "phase_started" || events[0].attempt !== 1) return false;
  let previous: PlanEvent | undefined;
  const eventIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const current of events) {
    if (current.run_id !== bundle.run_id || current.change_key !== bundle.change_key ||
        eventIds.has(current.event_id) || idempotencyKeys.has(current.idempotency_key)) return false;
    eventIds.add(current.event_id);
    idempotencyKeys.add(current.idempotency_key);
    if (previous !== undefined) {
      const previousPhase = PLAN_EVENT_PHASES.indexOf(previous.phase);
      const currentPhase = PLAN_EVENT_PHASES.indexOf(current.phase);
      const phaseRegressed = currentPhase < previousPhase;
      const samePhaseAttemptRegressed = currentPhase === previousPhase && current.attempt < previous.attempt;
      const sameProducer = currentPhase === previousPhase && current.attempt === previous.attempt;
      const newGroup = !sameProducer;
      if (phaseRegressed || samePhaseAttemptRegressed ||
          sameProducer && current.producer_seq <= previous.producer_seq ||
          Date.parse(current.occurred_at) < Date.parse(previous.occurred_at) ||
          newGroup && (previous.type !== "phase_ended" || current.type !== "phase_started") ||
          newGroup && currentPhase > previousPhase && current.attempt !== 1 ||
          newGroup && currentPhase === previousPhase && current.attempt !== previous.attempt + 1 ||
          !newGroup && (previous.type === "phase_ended" || current.type === "phase_started")) return false;
    }
    previous = current;
  }
  return true;
}

export async function readPlanEventBundle(
  serialized: unknown,
  hash_port: PlanEventBundleSha256Port
): Promise<PlanEventBundleReadResult> {
  if (typeof serialized !== "string") {
    return freeze({ ok: false, reason_code: "PLAN_EVENT_SERIALIZED_JSON_REQUIRED" });
  }
  if (serialized.length > 4_000_000) {
    return freeze({ ok: false, reason_code: "PLAN_EVENT_SERIALIZED_JSON_TOO_LARGE" });
  }
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(serialized) as unknown;
  } catch {
    return invalid();
  }
  if (parsedValue !== null && typeof parsedValue === "object" && !Array.isArray(parsedValue) &&
      Object.hasOwn(parsedValue, "schema_version") &&
      (parsedValue as Record<string, unknown>).schema_version !== 1) {
    return freeze({ ok: false, reason_code: "PLAN_EVENT_VERSION_UNSUPPORTED" });
  }
  const parsed = planEventBundleSchema.safeParse(parsedValue);
  if (!parsed.success || !validSequence(parsed.data)) return invalid();
  const value = parsed.data;
  try {
    for (const event of value.events) {
      const machine = eventMachine(event);
      const idempotencyHash = await hash_port.sha256(canonicalJson(machine));
      const eventHash = await hash_port.sha256(canonicalJson({ ...machine, occurred_at: event.occurred_at }));
      if (!hashSchema.safeParse(idempotencyHash).success || !hashSchema.safeParse(eventHash).success ||
          event.idempotency_key !== idempotencyHash || event.event_id !== `plan_event:${eventHash.slice(7)}`) return invalid();
    }
    const { bundle_hash: ignored, ...body } = value;
    void ignored;
    const bundleHash = await hash_port.sha256(canonicalJson(body));
    if (!hashSchema.safeParse(bundleHash).success || value.bundle_hash !== bundleHash) return invalid();
  } catch {
    return invalid();
  }
  return freeze({ ok: true, mode: value.events.at(-1)?.type === "phase_ended" ? "terminal" : "current",
    source_schema_version: 1, value });
}
