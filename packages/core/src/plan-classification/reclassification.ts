import {
  buildPlanProfile,
  validatePlanProfileIntegrity
} from "./classification.js";
import {
  planProfileSchema,
  planReclassificationSignalsSchema
} from "./schemas.js";
import { sortedUnique } from "./stable.js";
import type {
  PlanProfile,
  PlanReclassificationSignals
} from "./types.js";

export class PlanReclassificationError extends Error {
  readonly code:
    | "PLAN_RECLASSIFICATION_NO_CHANGE"
    | "PLAN_RECLASSIFICATION_SIGNAL_ALREADY_PRESENT"
    | "PLAN_RECLASSIFICATION_SIGNAL_MISSING";

  constructor(code: PlanReclassificationError["code"]) {
    super(code);
    this.name = "PlanReclassificationError";
    this.code = code;
  }
}

export function reclassifyPlan(
  previousProfileInput: PlanProfile,
  changedSignalsInput: PlanReclassificationSignals
): PlanProfile {
  const previous = validatePlanProfileIntegrity(
    planProfileSchema.parse(previousProfileInput)
  );
  const changes = planReclassificationSignalsSchema.parse(changedSignalsInput);
  if (changes.added_risk_signals.some(
    (signal) => previous.risk_signals.includes(signal)
  )) {
    throw new PlanReclassificationError(
      "PLAN_RECLASSIFICATION_SIGNAL_ALREADY_PRESENT"
    );
  }
  if (changes.removed_risk_signals.some(
    (signal) => !previous.risk_signals.includes(signal)
  )) {
    throw new PlanReclassificationError("PLAN_RECLASSIFICATION_SIGNAL_MISSING");
  }
  const nextSignals = sortedUnique([
    ...previous.risk_signals.filter(
      (signal) => !changes.removed_risk_signals.includes(signal)
    ),
    ...changes.added_risk_signals
  ]);
  if (
    nextSignals.length === previous.risk_signals.length
    && nextSignals.every((signal, index) => signal === previous.risk_signals[index])
  ) {
    throw new PlanReclassificationError("PLAN_RECLASSIFICATION_NO_CHANGE");
  }

  return buildPlanProfile({
    classification_input: {
      schema_version: 1,
      change_id: previous.change_id,
      risk_signals: nextSignals,
      created_at: changes.changed_at
    },
    profile_version: previous.profile_version + 1,
    supersedes: previous.profile_id,
    extra_reason_codes: ["risk_signals_changed"]
  });
}
