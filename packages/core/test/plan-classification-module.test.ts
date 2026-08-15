import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  classifyPlan,
  configurePlannedPhases,
  normalizeLegacyPlanState,
  planCapabilitiesSchema,
  planClassificationInputSchema,
  planProfileSchema,
  planReclassificationSignalsSchema,
  plannedPhaseSetSchema,
  reclassifyPlan,
  type PlanCapabilities,
  type PlanClassificationInput
} from "../src/plan-classification/index.js";
import {
  planProfileClassificationHash,
  planProfileId,
  plannedPhaseSetId
} from "../src/plan-classification/stable.js";

const CREATED_AT = "2026-08-13T08:00:00.000+08:00";

function classificationInput(
  overrides: Partial<PlanClassificationInput> = {}
): PlanClassificationInput {
  return {
    schema_version: 1,
    change_id: "plan-contract-refresh",
    display_title: "统一 Plan 契约",
    risk_signals: ["narrow_fix"],
    created_at: CREATED_AT,
    ...overrides
  };
}

function capabilities(overrides: Partial<PlanCapabilities> = {}): PlanCapabilities {
  return {
    schema_version: 1,
    is_git: true,
    has_remote: true,
    uses_worktree: false,
    available_phases: [
      "plan",
      "run",
      "test",
      "review",
      "package",
      "apidoc",
      "submit",
      "merge",
      "archive"
    ],
    requested_optional_phases: [],
    requested_omissions: [],
    configured_at: CREATED_AT,
    ...overrides
  };
}

describe("PlanClassificationModule classification", () => {
  it.each([
    { risk_signals: ["docs_only", "narrow_fix"] as const, mode: "quick" },
    { risk_signals: ["production_code", "cross_file"] as const, mode: "standard" },
    { risk_signals: ["security", "payment"] as const, mode: "assurance" }
  ])("maps deterministic risk signals to $mode", ({ risk_signals, mode }) => {
    const profile = classifyPlan(classificationInput({ risk_signals }));

    expect(profile.mode).toBe(mode);
    expect(profile.required_phases[0]).toBe("plan");
    expect(profile.required_phases.at(-1)).toBe("archive");
    expect(profile.optional_phases).not.toEqual(
      expect.arrayContaining(profile.required_phases)
    );
    expect(profile.required_validations).toEqual(
      mode === "quick"
        ? ["deterministic_check"]
        : mode === "standard"
          ? ["deterministic_check", "semantic_consistency"]
          : [
              "deterministic_check",
              "semantic_consistency",
              "adversarial_review"
            ]
    );
    expect(profile.interaction_budget.allowed_blocking_interactions).toEqual([
      "product_or_risk_decision",
      "concise_design_approval"
    ]);
    expect(profile.profile_version).toBe(1);
    expect(profile.supersedes).toBeUndefined();
    expect(profile.classification_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(profile.profile_id).toMatch(/^plan_profile:[a-f0-9]{64}$/u);
  });

  it("keeps ordering, hash and identity stable when signals or display title change order", () => {
    const first = classifyPlan(classificationInput({
      risk_signals: ["cross_file", "production_code"],
      display_title: "旧标题"
    }));
    const second = classifyPlan(classificationInput({
      risk_signals: ["production_code", "cross_file"],
      display_title: "更新后的中文标题",
      created_at: "2026-08-13T00:01:00.000Z"
    }));

    expect(first.risk_signals).toEqual(["cross_file", "production_code"]);
    expect(second.classification_hash).toBe(first.classification_hash);
    expect(second.profile_id).toBe(first.profile_id);
    expect(first.change_id).toBe("plan-contract-refresh");
    expect(second.change_id).toBe(first.change_id);
  });

  it("copies and freezes caller-owned classification arrays", () => {
    const riskSignals: PlanClassificationInput["risk_signals"] = [
      "production_code", "cross_file"
    ];
    const profile = classifyPlan(classificationInput({ risk_signals: riskSignals }));

    expect(profile.risk_signals).not.toBe(riskSignals);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.risk_signals)).toBe(true);
  });
});

describe("PlanClassificationModule phase configuration", () => {
  it("omits submit for a project without Git and creates no blocking confirmation", () => {
    const profile = classifyPlan(classificationInput({
      risk_signals: ["production_code"]
    }));
    const phaseSet = configurePlannedPhases(profile, capabilities({
      is_git: false,
      has_remote: false
    }));

    expect(phaseSet.outcome).toBe("configured");
    expect(phaseSet.planned_phases).not.toContain("submit");
    expect(phaseSet.omitted_phases).toContainEqual({
      phase: "submit",
      disposition: "not_applicable",
      reason_code: "submit_not_applicable_no_git"
    });
    expect(phaseSet.blocking_interactions).toEqual([]);
  });

  it("omits submit without a remote and adds merge only for worktree execution", () => {
    const profile = classifyPlan(classificationInput({
      risk_signals: ["production_code"]
    }));
    const phaseSet = configurePlannedPhases(profile, capabilities({
      has_remote: false,
      uses_worktree: true
    }));

    expect(phaseSet.planned_phases).not.toContain("submit");
    expect(phaseSet.planned_phases).toContain("merge");
    expect(phaseSet.omitted_phases.map(({ phase }) => phase)).not.toContain("merge");
    expect(phaseSet.planned_phases.at(-1)).toBe("archive");
    expect(phaseSet.source_reason_codes).toEqual(
      expect.arrayContaining([
        "merge_required_for_worktree",
        "submit_not_applicable_no_remote"
      ])
    );
  });

  it("allows a caller to omit an ordinary optional phase", () => {
    const profile = classifyPlan(classificationInput({
      risk_signals: ["production_code"]
    }));
    const phaseSet = configurePlannedPhases(profile, capabilities({
      requested_optional_phases: ["review"],
      requested_omissions: ["review"]
    }));

    expect(phaseSet.outcome).toBe("configured");
    expect(phaseSet.planned_phases).not.toContain("review");
    expect(phaseSet.omitted_phases).toContainEqual({
      phase: "review",
      disposition: "omitted_optional",
      reason_code: "optional_phase_omitted"
    });
  });

  it("does not pretend a high-risk required phase passed when a user narrows scope", () => {
    const profile = classifyPlan(classificationInput({
      risk_signals: ["migration"]
    }));
    const phaseSet = configurePlannedPhases(profile, capabilities({
      requested_omissions: ["review"]
    }));

    expect(phaseSet.outcome).toBe("not_publishable");
    expect(phaseSet.reason_code).toBe("required_phase_omission_rejected");
    expect(phaseSet.planned_phases).not.toContain("review");
    expect(phaseSet.omitted_phases).toContainEqual({
      phase: "review",
      disposition: "required_but_omitted",
      reason_code: "required_phase_omission_rejected"
    });
    expect(phaseSet.blocking_interactions).toEqual([
      "product_or_risk_decision"
    ]);
  });

  it("marks a required unavailable phase as not publishable without inventing evidence", () => {
    const profile = classifyPlan(classificationInput({
      risk_signals: ["security"]
    }));
    const phaseSet = configurePlannedPhases(profile, capabilities({
      available_phases: ["plan", "run", "test", "archive"]
    }));

    expect(phaseSet.outcome).toBe("not_publishable");
    expect(phaseSet.reason_code).toBe("required_phase_capability_missing");
    expect(phaseSet.omitted_phases).toContainEqual({
      phase: "review",
      disposition: "required_but_unavailable",
      reason_code: "required_phase_capability_missing"
    });
  });

  it("prioritizes an explicit required omission when capability loss also exists", () => {
    const profile = classifyPlan(classificationInput({
      risk_signals: ["migration"]
    }));
    const phaseSet = configurePlannedPhases(profile, capabilities({
      available_phases: ["plan", "run", "archive"],
      requested_omissions: ["review"]
    }));

    expect(phaseSet.omitted_phases).toEqual(expect.arrayContaining([
      {
        phase: "test",
        disposition: "required_but_unavailable",
        reason_code: "required_phase_capability_missing"
      },
      {
        phase: "review",
        disposition: "required_but_omitted",
        reason_code: "required_phase_omission_rejected"
      }
    ]));
    expect(phaseSet.outcome).toBe("not_publishable");
    expect(phaseSet.reason_code).toBe("required_phase_omission_rejected");
    expect(phaseSet.blocking_interactions).toEqual([
      "product_or_risk_decision"
    ]);
    expect(plannedPhaseSetSchema.parse(phaseSet)).toEqual(phaseSet);
  });

  it("keeps stable phase ordering, hashes and identities and prevents mutation aliases", () => {
    const profile = classifyPlan(classificationInput({
      risk_signals: ["production_code", "cross_file"]
    }));
    const firstCapabilities = capabilities({
      available_phases: ["archive", "submit", "test", "run", "plan", "review"],
      requested_optional_phases: ["submit", "review"]
    });
    const secondCapabilities = capabilities({
      available_phases: ["plan", "run", "test", "review", "submit", "archive"],
      requested_optional_phases: ["review", "submit"]
    });
    const first = configurePlannedPhases(profile, firstCapabilities);
    const second = configurePlannedPhases(profile, secondCapabilities);

    expect(first.planned_phases).toEqual([
      "plan", "run", "test", "review", "submit", "archive"
    ]);
    expect(second.capability_snapshot_hash).toBe(first.capability_snapshot_hash);
    expect(second.phase_set_id).toBe(first.phase_set_id);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.planned_phases)).toBe(true);
    expect(first.planned_phases).not.toBe(firstCapabilities.available_phases);
  });

  it("creates a new phase-set version with explicit lineage instead of overwriting", () => {
    const profile = classifyPlan(classificationInput({
      risk_signals: ["production_code"]
    }));
    const first = configurePlannedPhases(profile, capabilities());
    const second = configurePlannedPhases(profile, capabilities({
      previous_phase_set: {
        phase_set_id: first.phase_set_id,
        phase_set_version: first.phase_set_version
      },
      requested_optional_phases: ["review"]
    }));

    expect(second.phase_set_version).toBe(2);
    expect(second.supersedes).toBe(first.phase_set_id);
    expect(second.phase_set_id).not.toBe(first.phase_set_id);
    expect(first.supersedes).toBeUndefined();
  });

  it("rejects a format-valid but tampered profile and invalid optional selection", () => {
    const profile = classifyPlan(classificationInput({
      risk_signals: ["production_code"]
    }));
    expect(() => configurePlannedPhases({
      ...profile,
      classification_hash: `sha256:${"0".repeat(64)}`
    }, capabilities())).toThrow(/PLAN_PROFILE_INTEGRITY_INVALID/u);
    expect(() => configurePlannedPhases(profile, capabilities({
      requested_optional_phases: ["plan"]
    }))).toThrow(/PLAN_OPTIONAL_PHASE_INVALID/u);
  });
});

describe("PlanClassificationModule strict current schemas", () => {
  it("parses current v1 inputs and outputs", () => {
    const input = planClassificationInputSchema.parse(classificationInput());
    const profile = planProfileSchema.parse(classifyPlan(input));
    const capabilityInput = planCapabilitiesSchema.parse(capabilities());
    const phaseSet = plannedPhaseSetSchema.parse(
      configurePlannedPhases(profile, capabilityInput)
    );

    expect(phaseSet.schema_version).toBe(1);
  });

  it("rejects unknown and invalid fields instead of silently widening the contract", () => {
    expect(() => planClassificationInputSchema.parse({
      ...classificationInput(),
      displayTitle: "legacy camelCase is not current v1"
    })).toThrow(/PLAN_SCHEMA_UNKNOWN_FIELD/u);
    expect(() => planClassificationInputSchema.parse({
      ...classificationInput(),
      risk_signals: ["unknown_signal"]
    })).toThrow(/PLAN_SCHEMA_INVALID/u);
    expect(() => planCapabilitiesSchema.parse({
      ...capabilities(),
      available_phases: ["plan", "archive", "unknown"]
    })).toThrow(/PLAN_SCHEMA_INVALID/u);
    expect(() => planClassificationInputSchema.parse({
      ...classificationInput(),
      display_title: "标题中不允许\n控制字符"
    })).toThrow(/PLAN_SCHEMA_INVALID/u);
  });

  it("rejects format-valid output hashes and identities that do not match content", () => {
    const profile = classifyPlan(classificationInput());
    expect(() => planProfileSchema.parse({
      ...profile,
      classification_hash: `sha256:${"0".repeat(64)}`
    })).toThrow(/PLAN_PROFILE_INTEGRITY_INVALID/u);
    const phaseSet = configurePlannedPhases(profile, capabilities());
    expect(() => plannedPhaseSetSchema.parse({
      ...phaseSet,
      phase_set_id: `planned_phase_set:${"0".repeat(64)}`
    })).toThrow(/PLAN_PHASE_SET_INTEGRITY_INVALID/u);
  });

  it("binds every blocking interaction to phase-set identity", () => {
    const profile = classifyPlan(classificationInput({
      risk_signals: ["production_code"]
    }));
    const configured = configurePlannedPhases(profile, capabilities());
    expect(() => plannedPhaseSetSchema.parse({
      ...configured,
      blocking_interactions: ["concise_design_approval"]
    })).toThrow(/PLAN_PHASE_SET_INTEGRITY_INVALID/u);

    const blocked = configurePlannedPhases(
      classifyPlan(classificationInput({ risk_signals: ["migration"] })),
      capabilities({ requested_omissions: ["review"] })
    );
    expect(() => plannedPhaseSetSchema.parse({
      ...blocked,
      blocking_interactions: []
    })).toThrow(/PLAN_PHASE_SET_INTEGRITY_INVALID/u);
  });

  it("rejects invalid blocking semantics even when an attacker recomputes the identity", () => {
    const profile = classifyPlan(classificationInput({
      risk_signals: ["production_code"]
    }));
    const configured = configurePlannedPhases(profile, capabilities());
    const configuredAttack = {
      ...configured,
      blocking_interactions: ["concise_design_approval"] as const
    };
    expect(() => plannedPhaseSetSchema.parse({
      ...configuredAttack,
      phase_set_id: plannedPhaseSetId(configuredAttack)
    })).toThrow(/PLAN_PHASE_SET_CONTRADICTION/u);

    const blocked = configurePlannedPhases(
      classifyPlan(classificationInput({ risk_signals: ["migration"] })),
      capabilities({ requested_omissions: ["review"] })
    );
    const blockedAttack = {
      ...blocked,
      blocking_interactions: []
    };
    expect(() => plannedPhaseSetSchema.parse({
      ...blockedAttack,
      phase_set_id: plannedPhaseSetId(blockedAttack)
    })).toThrow(/PLAN_PHASE_SET_CONTRADICTION/u);
  });

  it("rejects a high-risk profile downgraded with fully recomputed identities", () => {
    const assurance = classifyPlan(classificationInput({
      risk_signals: ["migration"]
    }));
    const downgradedFields = {
      ...assurance,
      mode: "quick" as const,
      required_phases: ["plan", "run", "archive"] as const,
      optional_phases: [
        "test", "review", "package", "apidoc", "submit", "merge"
      ] as const,
      required_validations: ["deterministic_check"] as const,
      interaction_budget: {
        max_clarification_rounds: 1,
        allowed_blocking_interactions: [
          "product_or_risk_decision", "concise_design_approval"
        ] as const
      },
      reason_codes: ["low_risk_scope"] as const
    };
    const classificationHash = planProfileClassificationHash(downgradedFields);
    const downgraded = {
      ...downgradedFields,
      classification_hash: classificationHash,
      profile_id: planProfileId({
        change_id: downgradedFields.change_id,
        classification_hash: classificationHash,
        profile_version: downgradedFields.profile_version,
        supersedes: downgradedFields.supersedes
      })
    };

    expect(() => planProfileSchema.parse(downgraded)).toThrow(
      /PLAN_PROFILE_INTEGRITY_INVALID/u
    );
  });

  it("rejects deleting a required omission and recomputing a configured identity", () => {
    const blocked = configurePlannedPhases(
      classifyPlan(classificationInput({ risk_signals: ["migration"] })),
      capabilities({ requested_omissions: ["review"] })
    );
    const attack = {
      ...blocked,
      omitted_phases: blocked.omitted_phases.filter(({ phase }) => phase !== "review"),
      source_reason_codes: blocked.source_reason_codes.filter(
        (reason) => reason !== "required_phase_omission_rejected"
      ),
      blocking_interactions: [] as const,
      outcome: "configured" as const,
      reason_code: "phase_set_configured" as const
    };

    expect(() => plannedPhaseSetSchema.parse({
      ...attack,
      phase_set_id: plannedPhaseSetId(attack)
    })).toThrow(/PLAN_PHASE_SET_CONTRADICTION/u);
  });

  it("enforces profile lineage version, presence and non-self invariants", () => {
    const first = classifyPlan(classificationInput());
    expect(() => planProfileSchema.parse({
      ...first,
      supersedes: first.profile_id
    })).toThrow(/PLAN_PROFILE_LINEAGE_INVALID/u);
    expect(() => planProfileSchema.parse({
      ...first,
      profile_version: 2
    })).toThrow(/PLAN_PROFILE_LINEAGE_INVALID/u);

    const second = reclassifyPlan(first, {
      schema_version: 1,
      added_risk_signals: ["security"],
      removed_risk_signals: [],
      changed_at: "2026-08-13T09:00:00Z"
    });
    expect(() => planProfileSchema.parse({
      ...second,
      supersedes: second.profile_id
    })).toThrow(/PLAN_PROFILE_LINEAGE_INVALID/u);
  });

  it("enforces phase-set lineage version, presence and non-self invariants", () => {
    const profile = classifyPlan(classificationInput());
    const first = configurePlannedPhases(profile, capabilities());
    expect(() => plannedPhaseSetSchema.parse({
      ...first,
      supersedes: first.phase_set_id
    })).toThrow(/PLAN_PHASE_SET_LINEAGE_INVALID/u);
    expect(() => plannedPhaseSetSchema.parse({
      ...first,
      phase_set_version: 2
    })).toThrow(/PLAN_PHASE_SET_LINEAGE_INVALID/u);

    const second = configurePlannedPhases(profile, capabilities({
      previous_phase_set: {
        phase_set_id: first.phase_set_id,
        phase_set_version: first.phase_set_version
      }
    }));
    expect(() => plannedPhaseSetSchema.parse({
      ...second,
      supersedes: second.phase_set_id
    })).toThrow(/PLAN_PHASE_SET_LINEAGE_INVALID/u);
  });

  it("rejects contradictory planned/omitted and outcome/disposition combinations", () => {
    const profile = classifyPlan(classificationInput({
      risk_signals: ["migration"]
    }));
    const blocked = configurePlannedPhases(profile, capabilities({
      requested_omissions: ["review"]
    }));
    const conflict = blocked.omitted_phases.find(({ phase }) => phase === "review");
    expect(conflict).toBeDefined();
    expect(() => plannedPhaseSetSchema.parse({
      ...blocked,
      planned_phases: [...blocked.planned_phases, "review"]
    })).toThrow(/PLAN_PHASE_SET_CONTRADICTION/u);
    expect(() => plannedPhaseSetSchema.parse({
      ...blocked,
      outcome: "configured",
      reason_code: "phase_set_configured",
      blocking_interactions: []
    })).toThrow(/PLAN_PHASE_SET_CONTRADICTION/u);

    const unavailable = configurePlannedPhases(profile, capabilities({
      available_phases: ["plan", "run", "test", "archive"]
    }));
    expect(unavailable.reason_code).toBe("required_phase_capability_missing");
    expect(() => plannedPhaseSetSchema.parse({
      ...unavailable,
      reason_code: "required_phase_omission_rejected"
    })).toThrow(/PLAN_PHASE_SET_CONTRADICTION/u);
  });

  it("rejects missing or stale omission machine reasons after identity recomputation", () => {
    const profile = classifyPlan(classificationInput({ risk_signals: ["migration"] }));
    const blocked = configurePlannedPhases(profile, capabilities({
      requested_omissions: ["review"]
    }));
    const missing = {
      ...blocked,
      source_reason_codes: blocked.source_reason_codes.filter(
        (reason) => reason !== "required_phase_omission_rejected"
      )
    };
    expect(() => plannedPhaseSetSchema.parse({
      ...missing,
      phase_set_id: plannedPhaseSetId(missing)
    })).toThrow(/PLAN_PHASE_SET_CONTRADICTION/u);

    const configured = configurePlannedPhases(
      classifyPlan(classificationInput({ risk_signals: ["production_code"] })),
      capabilities()
    );
    const stale = {
      ...configured,
      source_reason_codes: [
        ...configured.source_reason_codes,
        "required_phase_omission_rejected" as const
      ].sort()
    };
    expect(() => plannedPhaseSetSchema.parse({
      ...stale,
      phase_set_id: plannedPhaseSetId(stale)
    })).toThrow(/PLAN_PHASE_SET_CONTRADICTION/u);
  });

  it("rejects unverifiable optional-selected provenance after identity recomputation", () => {
    const quick = classifyPlan(classificationInput({ risk_signals: ["narrow_fix"] }));
    const phaseSet = configurePlannedPhases(quick, capabilities());
    expect(phaseSet.planned_phases).toEqual(["plan", "run", "archive"]);
    const attack = {
      ...phaseSet,
      source_reason_codes: [
        ...phaseSet.source_reason_codes,
        "optional_phase_selected" as const
      ].sort()
    };

    expect(() => plannedPhaseSetSchema.parse({
      ...attack,
      phase_set_id: plannedPhaseSetId(attack)
    })).toThrow(/PLAN_PHASE_SET_CONTRADICTION/u);
  });

  it("rejects impossible Git, remote and worktree capability combinations", () => {
    expect(() => planCapabilitiesSchema.parse(capabilities({
      is_git: false,
      has_remote: true,
      uses_worktree: false
    }))).toThrow(/PLAN_CAPABILITIES_CONTRADICTION/u);
    expect(() => planCapabilitiesSchema.parse(capabilities({
      is_git: false,
      has_remote: false,
      uses_worktree: true
    }))).toThrow(/PLAN_CAPABILITIES_CONTRADICTION/u);
  });
});

describe("PlanClassificationModule reclassification", () => {
  it("creates a new traceable profile version when design raises risk", () => {
    const previous = classifyPlan(classificationInput({
      risk_signals: ["production_code"]
    }));
    const next = reclassifyPlan(previous, {
      schema_version: 1,
      added_risk_signals: ["migration", "concurrency"],
      removed_risk_signals: [],
      changed_at: "2026-08-13T09:00:00.000+08:00"
    });

    expect(next.mode).toBe("assurance");
    expect(next.profile_version).toBe(previous.profile_version + 1);
    expect(next.supersedes).toBe(previous.profile_id);
    expect(next.profile_id).not.toBe(previous.profile_id);
    expect(next.classification_hash).not.toBe(previous.classification_hash);
    expect(next.reason_codes).toContain("risk_signals_changed");
    expect(previous.mode).toBe("standard");
    expect(previous.supersedes).toBeUndefined();
  });

  it("rejects no-op or contradictory signal changes with fixed machine errors", () => {
    const previous = classifyPlan(classificationInput({
      risk_signals: ["production_code"]
    }));
    expect(() => reclassifyPlan(previous, {
      schema_version: 1,
      added_risk_signals: [],
      removed_risk_signals: [],
      changed_at: CREATED_AT
    })).toThrow(/PLAN_RECLASSIFICATION_NO_CHANGE/u);
    expect(() => planReclassificationSignalsSchema.parse({
      schema_version: 1,
      added_risk_signals: ["migration"],
      removed_risk_signals: ["migration"],
      changed_at: CREATED_AT
    })).toThrow(/PLAN_RECLASSIFICATION_SIGNAL_CONFLICT/u);
    expect(() => reclassifyPlan(previous, {
      schema_version: 1,
      added_risk_signals: ["security"],
      removed_risk_signals: ["migration"],
      changed_at: CREATED_AT
    })).toThrow(/PLAN_RECLASSIFICATION_SIGNAL_MISSING/u);
  });
});

describe("PlanClassificationModule legacy compatibility", () => {
  it("normalizes a real legacy tier/plannedPhases fixture without retaining dual-write keys", async () => {
    const legacy = JSON.parse(await readFile(
      new URL("./fixtures/plan-classification-v0-legacy.json", import.meta.url),
      "utf8"
    )) as unknown;
    const normalized = normalizeLegacyPlanState(legacy);

    expect(normalized.source_format).toBe("legacy_gate_policy_v0");
    expect(normalized.profile.mode).toBe("assurance");
    expect(normalized.profile.profile_version).toBe(1);
    expect(normalized.phase_set.planned_phases).toEqual([
      "plan", "run", "test", "review", "submit", "archive"
    ]);
    expect(normalized.phase_set.outcome).toBe("configured");
    expect(planProfileSchema.parse(normalized.profile)).toEqual(normalized.profile);
    expect(plannedPhaseSetSchema.parse(normalized.phase_set)).toEqual(
      normalized.phase_set
    );
    expect(JSON.stringify(normalized)).not.toMatch(
      /schemaVersion|changeId|defaultPhases|plannedPhases|skippedPhases|classifiedAt/u
    );
  });

  it("does not use legacy Chinese display reasons or operator names as recovery input", async () => {
    const legacy = JSON.parse(await readFile(
      new URL("./fixtures/plan-classification-v0-legacy.json", import.meta.url),
      "utf8"
    )) as Record<string, unknown>;
    const altered = structuredClone(legacy);
    altered.skippedPhases = [{
      phase: "package",
      reason: "任意中文展示原因，不可作为机器恢复输入",
      operator: "另一个操作人",
      decidedAt: "2030-01-01T00:00:00Z"
    }];

    const first = normalizeLegacyPlanState(legacy);
    const second = normalizeLegacyPlanState(altered);
    expect(second.profile.classification_hash).toBe(
      first.profile.classification_hash
    );
    expect(second.phase_set.capability_snapshot_hash).toBe(
      first.phase_set.capability_snapshot_hash
    );
    expect(second.phase_set.phase_set_id).toBe(first.phase_set.phase_set_id);
  });

  it("does not invent no-git or no-remote semantics when a legacy fast plan omits submit", async () => {
    const legacy = JSON.parse(await readFile(
      new URL("./fixtures/plan-classification-v0-legacy.json", import.meta.url),
      "utf8"
    )) as Record<string, unknown>;
    legacy.tier = "fast";
    legacy.signals = ["docs-only"];
    legacy.defaultPhases = ["plan", "run", "archive"];
    legacy.plannedPhases = ["plan", "run", "archive"];
    legacy.requiredValidations = ["unitTest"];
    legacy.skippedPhases = [{
      phase: "submit",
      reason: "本次只是快速迭代",
      operator: "legacy-agent",
      decidedAt: "2026-08-12T00:00:00Z"
    }];

    const normalized = normalizeLegacyPlanState(legacy);
    const submit = normalized.phase_set.omitted_phases.find(
      ({ phase }) => phase === "submit"
    );
    expect(submit).toEqual({
      phase: "submit",
      disposition: "omitted_optional",
      reason_code: "legacy_optional_phase_omitted"
    });
    expect(normalized.phase_set.source_reason_codes).toContain(
      "legacy_phase_plan_mapped"
    );
    expect(normalized.phase_set.source_reason_codes).not.toEqual(
      expect.arrayContaining([
        "submit_not_applicable_no_git",
        "submit_not_applicable_no_remote"
      ])
    );
  });

  it("maps the legacy standard tier explicitly to the current standard mode", async () => {
    const legacy = JSON.parse(await readFile(
      new URL("./fixtures/plan-classification-v0-legacy.json", import.meta.url),
      "utf8"
    )) as Record<string, unknown>;
    legacy.tier = "standard";
    legacy.signals = ["production-code"];
    legacy.defaultPhases = ["plan", "run", "test", "submit", "archive"];
    legacy.plannedPhases = ["plan", "run", "test", "submit", "archive"];
    legacy.requiredValidations = ["compile", "unitTest", "unitTestFull"];
    legacy.skippedPhases = [];

    const normalized = normalizeLegacyPlanState(legacy);
    expect(normalized.profile.mode).toBe("standard");
    expect(normalized.profile.reason_codes).toContain("legacy_complexity_mapped");
    expect(normalized.phase_set.planned_phases).toEqual([
      "plan", "run", "test", "submit", "archive"
    ]);
  });

  it("loads a current v1 fixture through strict schemas", async () => {
    const current = JSON.parse(await readFile(
      new URL("./fixtures/plan-classification-v1-current.json", import.meta.url),
      "utf8"
    )) as Record<string, unknown>;

    const input = planClassificationInputSchema.parse(current.classification_input);
    const capabilityInput = planCapabilitiesSchema.parse(current.capabilities);
    expect(input).toEqual(current.classification_input);
    expect(capabilityInput).toEqual(current.capabilities);
    expect(planProfileSchema.parse(current.profile)).toEqual(current.profile);
    expect(plannedPhaseSetSchema.parse(current.phase_set)).toEqual(current.phase_set);
    const profile = classifyPlan(input);
    expect(profile).toEqual(current.profile);
    expect(configurePlannedPhases(profile, capabilityInput)).toEqual(current.phase_set);
  });
});
