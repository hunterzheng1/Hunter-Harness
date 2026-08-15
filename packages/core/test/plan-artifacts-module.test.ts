import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { PLAN_PHASES, classifyPlan, configurePlannedPhases } from "../src/plan-classification/index.js";
import { createPlanningContextModule } from "../src/planning-context/index.js";
import { createPlanDecisionModule, type ApprovalContentInput } from "../src/plan-decision/index.js";
import {
  createPlanArtifactModel,
  MODULE_GENERATOR_VERSION,
  type CoverageApplicabilityInput,
  type HumanArtifactBuildInput,
  type PlanArtifactError,
  type TestScenarioInput
} from "../src/plan-artifacts/index.js";

const now = "2026-08-13T10:00:00.000Z";
const sha = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as const;
const dimensions = ["business_rules", "concurrency_idempotency", "data_compatibility", "error_codes",
  "integration_impact", "normal_path", "parameter_validation", "permission_boundaries"] as const;

function testHash(value: unknown): `sha256:${string}` {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") return Object.fromEntries(Object.entries(input)
      .filter(([, child]) => child !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]));
    return input;
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function withoutKeys(value: object, keys: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function approvalContent(): ApprovalContentInput {
  return {
    goal: "稳定生成规划产物", user_visible_outcome: "修改计划后派生产物同步更新",
    in_scope: ["plan_artifacts"], out_of_scope: ["finalizer"], recommended_design: "三份人类真相源驱动机器派生物",
    key_alternatives: ["继续维护四份人工文档"], invariants: ["机器产物不得引入人工事实"],
    failure_behaviors: ["来源漂移时拒绝验证"], compatibility_boundaries: ["保留旧六项输入只读兼容"],
    risks: [{ risk: "派生物漂移", mitigation: "绑定来源哈希并重建" }],
    acceptance_examples: ["quick detail 幂等", "plan 修改后 checkpoints 更新", "旧 frontmatter 可读"]
  };
}

function scenario(scenario_id: string, coverage_dimension: TestScenarioInput["coverage_dimension"],
  risk_level: TestScenarioInput["risk_level"], task_refs: readonly string[],
  requirement_refs: readonly string[]): TestScenarioInput {
  return { scenario_id, title: `验证 ${coverage_dimension}`, acceptance: `${coverage_dimension} 行为符合批准设计`,
    coverage_dimension, execution_level: coverage_dimension === "integration_impact" ? "integration" : "unit",
    evidence_requirements: ["focused_test"], verification_command: `npm test -- ${scenario_id}`, risk_level,
    task_refs, requirement_refs };
}

function trustedInput(mode: "quick" | "standard" | "assurance" = "standard"): HumanArtifactBuildInput {
  const signals = mode === "quick" ? ["narrow_fix"] as const : mode === "standard" ?
    ["production_code", "cross_file"] as const : ["security", "payment"] as const;
  const profile = classifyPlan({ schema_version: 1, change_id: `change-11-${mode}`, risk_signals: signals, created_at: now });
  const phase_set = configurePlannedPhases(profile, { schema_version: 1, is_git: true, has_remote: true,
    uses_worktree: false, available_phases: PLAN_PHASES, requested_optional_phases: [], requested_omissions: [],
    configured_at: now });
  const planning = createPlanningContextModule();
  const intent = planning.buildIntent({ schema_version: 1, source_input: "收敛规划产物", goal: "稳定生成规划产物",
    user_visible_outcome: "修改计划后派生产物同步更新", in_scope: ["plan_artifacts"], out_of_scope: ["finalizer"],
    constraints: ["legacy_read_only"], acceptance_examples: ["产物幂等", "来源漂移拒绝"], uncertainties: [], created_at: now });
  const evidence = planning.buildEvidenceMap({ schema_version: 1, map_manifest_hash: sha("a"), sources: [{
    source_kind: "map", source_id: "map:plan-artifacts", source_version: "v1", content_hash: sha("b"),
    module_refs: ["plan_artifacts"], symbol_refs: ["PlanArtifactModel"], consumer_refs: ["finalizer"],
    test_refs: ["plan-artifacts-module.test.ts"], constraint_refs: ["legacy_read_only"], unknown_refs: []
  }], budget: { max_sources: 2, max_refs: 16 }, created_at: now });
  const context = planning.buildPlanningContext({ profile, phase_set, intent, evidence,
    map_manifest_hash: sha("a"), created_at: now });
  const decision = createPlanDecisionModule();
  const graph = decision.evaluateDecisionGraph({ schema_version: 1, profile, phase_set, context, intent, evidence,
    nodes: [], evaluated_at: now });
  const content = approvalContent();
  const approval_package_input = { content, created_at: now };
  const approval_package = decision.buildApprovalPackage({ schema_version: 1, profile, phase_set, context, intent,
    evidence, graph, ...approval_package_input });
  const approval_receipt = decision.recordApproval({ package: approval_package, graph, profile, phase_set, context,
    intent, evidence, package_input: approval_package_input, outcome: "approved", approver_id: "user:owner",
    decided_at: now }).receipt;
  const scopeText = "plan_artifacts";
  const scope_ref = `scope:${testHash({ text: scopeText }).slice(7)}`;
  const evidence_refs = ["module:plan_artifacts", "symbol:PlanArtifactModel"];
  const requirementSource = [{ kind: "behavior" as const, text: content.recommended_design },
    ...content.invariants.map((text) => ({ kind: "invariant" as const, text })),
    ...content.failure_behaviors.map((text) => ({ kind: "failure_behavior" as const, text }))];
  const requirements = requirementSource.map((item) => { const body = { ...item, evidence_refs,
    approved_scope_refs: [scope_ref] }; return { requirement_id: `requirement:${testHash(body).slice(7)}`, ...body }; });
  const requirement_refs = requirements.map((item) => item.requirement_id);
  const task_refs = ["task:module", "task:test"];
  const scenarios = [scenario("scenario:normal", "normal_path", "medium", task_refs, requirement_refs),
    scenario("scenario:parameter", "parameter_validation", "medium", task_refs, requirement_refs),
    scenario("scenario:integration", "integration_impact", "high", task_refs, requirement_refs)];
  const coverage: CoverageApplicabilityInput[] = dimensions.map((coverage_dimension) => {
    const refs = scenarios.filter((item) => item.coverage_dimension === coverage_dimension)
      .map((item) => item.scenario_id);
    return refs.length > 0 ? { coverage_dimension, applicability: "applicable", scenario_refs: refs } :
      { coverage_dimension, applicability: "not_applicable", scenario_refs: [],
        not_applicable_reason: `当前变更不涉及 ${coverage_dimension}` };
  });
  const ownership = ["packages/core/src/plan-artifacts/module.ts", "packages/core/test/plan-artifacts-module.test.ts"]
    .map((path) => { const body = { path, approved_scope_refs: [scope_ref], evidence_refs };
      return { ownership_ref: `ownership:${testHash(body).slice(7)}`, ...body }; });
  const moduleOwnership = ownership[0]; const testOwnership = ownership[1];
  if (moduleOwnership === undefined || testOwnership === undefined) throw new Error("missing ownership fixture");
  return { schema_version: 2, profile, phase_set, context, intent, evidence, graph, approval_package,
    approval_package_input, approval_receipt, structured_input: { change_key: `change-11-${mode}`, tasks: [{
      task_id: "task:module", objective: "实现 PlanArtifactModel", affected_paths: ["packages/core/src/plan-artifacts/module.ts"],
      depends_on: [], owner_phase: "run", decision_refs: [], scenario_refs: scenarios.map((item) => item.scenario_id),
      requirement_refs, evidence_refs, ownership_refs: [moduleOwnership.ownership_ref]
    }, { task_id: "task:test", objective: "验证产物派生", affected_paths: ["packages/core/test/plan-artifacts-module.test.ts"],
      depends_on: ["task:module"], owner_phase: mode === "quick" ? "run" : "test", decision_refs: [],
      scenario_refs: scenarios.map((item) => item.scenario_id), requirement_refs, evidence_refs,
      ownership_refs: [testOwnership.ownership_ref] }], scenarios, coverage, requirements,
      approved_scopes: [{ scope_ref, text: scopeText }], ownership } };
}

describe("PlanArtifactModel human truth sources", () => {
  it("builds three non-overlapping human artifacts from one approved input", () => {
    const model = createPlanArtifactModel();
    const human = model.buildHumanArtifacts(trustedInput());
    expect(human.design.content).toMatchObject({ goal: "稳定生成规划产物", behavior_contract: "三份人类真相源驱动机器派生物" });
    expect(human.plan.content.tasks).toHaveLength(2);
    expect(human.test_scenarios.content.scenarios).toHaveLength(3);
    expect(human.design).not.toHaveProperty("tasks");
    expect(human.plan.content).not.toHaveProperty("goal");
    expect(human.test_scenarios.content).not.toHaveProperty("recommended_design");
    expect(new Set([human.design.artifact_id, human.plan.artifact_id, human.test_scenarios.artifact_id]).size).toBe(3);
    expect(Object.isFrozen(human)).toBe(true);
  });

  it("requires a trusted approved receipt and rejects task cycles or dangling references", () => {
    const model = createPlanArtifactModel();
    const input = trustedInput();
    expect(() => model.buildHumanArtifacts({ ...input,
      approval_receipt: { ...input.approval_receipt, outcome: "cancelled" } }))
      .toThrowError(expect.objectContaining<Partial<PlanArtifactError>>({ code: "PLAN_ARTIFACT_APPROVAL_INVALID" }));
    const tasks = input.structured_input.tasks.map((task) => ({ ...task,
      depends_on: [task.task_id === "task:module" ? "task:test" : "task:module"] }));
    expect(() => model.buildHumanArtifacts({ ...input, structured_input: { ...input.structured_input, tasks } }))
      .toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_REFERENCE_INVALID" }));
    expect(() => model.buildHumanArtifacts({ ...input, structured_input: { ...input.structured_input,
      tasks: [{ ...input.structured_input.tasks[0] as HumanArtifactBuildInput["structured_input"]["tasks"][number],
        scenario_refs: ["scenario:missing"] }] } }))
      .toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_REFERENCE_INVALID" }));
  });

  it("requires all eight dimensions and a reason for every not-applicable dimension", () => {
    const model = createPlanArtifactModel();
    const input = trustedInput("assurance");
    expect(model.buildHumanArtifacts(input).test_scenarios.content.coverage.map((item) => item.coverage_dimension))
      .toEqual(dimensions);
    const coverage = input.structured_input.coverage.map((item) => item.applicability === "not_applicable" ?
      { ...item, not_applicable_reason: undefined } : item);
    expect(() => model.buildHumanArtifacts({ ...input, structured_input: { ...input.structured_input, coverage } }))
      .toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_INPUT_INVALID" }));
  });

  it("requires each task owner phase to be in the trusted planned phase set", () => {
    const model = createPlanArtifactModel();
    const input = trustedInput("quick");
    expect(input.phase_set.planned_phases).not.toContain("test");
    const tasks = input.structured_input.tasks.map((task) => task.task_id === "task:test" ?
      { ...task, owner_phase: "test" as const } : task);
    expect(() => model.buildHumanArtifacts({ ...input, structured_input: { ...input.structured_input, tasks } }))
      .toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_REFERENCE_INVALID" }));
  });

  it("closes requirement, task, scenario, evidence, and ownership references", () => {
    const model = createPlanArtifactModel(); const input = trustedInput();
    const behavior = input.structured_input.requirements?.find((item) => item.kind === "behavior");
    if (behavior === undefined) throw new Error("missing behavior fixture");
    const tasksWithoutBehavior = input.structured_input.tasks.map((task) => ({ ...task,
      requirement_refs: task.requirement_refs?.filter((ref) => ref !== behavior.requirement_id) }));
    expect(() => model.buildHumanArtifacts({ ...input, structured_input: { ...input.structured_input,
      tasks: tasksWithoutBehavior } })).toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_REFERENCE_INVALID" }));
    const scenariosWithoutBehavior = input.structured_input.scenarios.map((scenario) => ({ ...scenario,
      requirement_refs: scenario.requirement_refs?.filter((ref) => ref !== behavior.requirement_id) }));
    expect(() => model.buildHumanArtifacts({ ...input, structured_input: { ...input.structured_input,
      scenarios: scenariosWithoutBehavior } })).toThrowError(expect.objectContaining({
      code: "PLAN_ARTIFACT_REFERENCE_INVALID"
    }));
    const danglingEvidence = input.structured_input.tasks.map((task, index) => index === 0 ?
      { ...task, evidence_refs: ["module:foreign"] } : task);
    expect(() => model.buildHumanArtifacts({ ...input, structured_input: { ...input.structured_input,
      tasks: danglingEvidence } })).toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_REFERENCE_INVALID" }));
    const noOwnership = input.structured_input.tasks.map((task, index) => index === 0 ?
      { ...task, ownership_refs: input.structured_input.ownership?.slice(1).map((item) => item.ownership_ref) } : task);
    expect(() => model.buildHumanArtifacts({ ...input, structured_input: { ...input.structured_input,
      tasks: noOwnership } })).toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_REFERENCE_INVALID" }));
    const danglingTask = input.structured_input.scenarios.map((scenario, index) => index === 0 ?
      { ...scenario, task_refs: ["task:missing"] } : scenario);
    expect(() => model.buildHumanArtifacts({ ...input, structured_input: { ...input.structured_input,
      scenarios: danglingTask } })).toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_REFERENCE_INVALID" }));
  });

  it("requires task and scenario references to form one exact bidirectional relation", () => {
    const model = createPlanArtifactModel(); const input = trustedInput();
    const scenarioId = input.structured_input.scenarios[0]?.scenario_id;
    if (scenarioId === undefined) throw new Error("missing scenario fixture");
    const tasks = input.structured_input.tasks.map((task, index) => index === 0 ? { ...task,
      scenario_refs: task.scenario_refs.filter((ref) => ref !== scenarioId) } : task);
    expect(() => model.buildHumanArtifacts({ ...input, structured_input: { ...input.structured_input, tasks } }))
      .toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_REFERENCE_INVALID" }));

    const scenarios = input.structured_input.scenarios.map((scenario, index) => index === 0 ? { ...scenario,
      task_refs: scenario.task_refs.filter((ref) => ref !== "task:module") } : scenario);
    expect(() => model.buildHumanArtifacts({ ...input, structured_input: { ...input.structured_input, scenarios } }))
      .toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_REFERENCE_INVALID" }));
  });

  it("rejects cross-linked scenarios whose requirements are not implemented by their referenced tasks", () => {
    const model = createPlanArtifactModel(); const input = trustedInput();
    const scenario = input.structured_input.scenarios[0];
    const requirement = input.structured_input.requirements[0];
    if (scenario === undefined || requirement === undefined) throw new Error("missing semantic fixture");
    const tasks = input.structured_input.tasks.map((task) => task.task_id === "task:module" ? { ...task,
      requirement_refs: task.requirement_refs.filter((ref) => ref !== requirement.requirement_id) } : { ...task,
      scenario_refs: task.scenario_refs.filter((ref) => ref !== scenario.scenario_id) });
    const scenarios = input.structured_input.scenarios.map((item) => item.scenario_id === scenario.scenario_id ? {
      ...item, task_refs: ["task:module"], requirement_refs: [requirement.requirement_id]
    } : item);
    expect(() => model.buildHumanArtifacts({ ...input, structured_input: { ...input.structured_input,
      tasks, scenarios } })).toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_REFERENCE_INVALID" }));
  });
});

describe("PlanArtifactModel derived artifacts", () => {
  it("derives gate policy, worktree, checkpoints, and scenario manifest without manual fields", () => {
    const model = createPlanArtifactModel();
    const input = trustedInput();
    const human = model.buildHumanArtifacts(input);
    const machine = model.deriveMachineArtifacts({ schema_version: 2, profile: input.profile,
      phase_set: input.phase_set, capabilities: ["api", "database"], worktree_policy: "project_default",
      human_input: input, human });
    expect(machine.gate_policy.content).toMatchObject({ mode: "standard", capabilities: ["api", "database"] });
    expect(machine.gate_policy.source_hashes).toEqual(expect.objectContaining({ capabilities: expect.stringMatching(/^sha256:/u),
      plan_profile: expect.stringMatching(/^sha256:/u), planned_phase_set: expect.stringMatching(/^sha256:/u) }));
    expect(machine.implementation_checkpoints.content.tasks).toHaveLength(2);
    expect(machine.scenario_manifest.content.scenarios).toHaveLength(3);
    for (const value of Object.values(machine).filter((item) => item && typeof item === "object" && "artifact_id" in item)) {
      expect(value).toMatchObject({ schema_version: 2, generator_version: MODULE_GENERATOR_VERSION,
        content_hash: expect.stringMatching(/^sha256:/u), source_hashes: expect.any(Object) });
    }
  });

  it("rejects a self-rehashed human artifact and foreign profile at the machine boundary", () => {
    const model = createPlanArtifactModel();
    const input = trustedInput();
    const human = model.buildHumanArtifacts(input);
    const dependentTask = human.plan.content.tasks.find((task) => task.task_id === "task:test");
    if (dependentTask === undefined) throw new Error("missing fixture task");
    const content = { ...human.plan.content, tasks: human.plan.content.tasks.map((task, index) => index === 0 ?
      { ...task, depends_on: [dependentTask.task_id] } : task) };
    const content_hash = testHash({ artifact_type: "plan", content });
    const plan = { ...human.plan, content, content_hash,
      artifact_id: `plan_artifact:plan:${content_hash.slice("sha256:".length)}` };
    const body = { schema_version: 2 as const, design: human.design, plan, test_scenarios: human.test_scenarios };
    const artifact_set_hash = testHash(body);
    const forged = { ...body, artifact_set_hash,
      artifact_set_id: `plan_artifact_set:${artifact_set_hash.slice("sha256:".length)}` };
    expect(() => model.deriveMachineArtifacts({ schema_version: 2, profile: input.profile,
      phase_set: input.phase_set, capabilities: [], worktree_policy: "project_default", human_input: input,
      human: forged })).toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_INPUT_INVALID" }));
    const foreign = trustedInput("assurance");
    expect(() => model.deriveMachineArtifacts({ schema_version: 2, profile: foreign.profile,
      phase_set: foreign.phase_set, capabilities: [], worktree_policy: "project_default", human_input: input,
      human })).toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_INPUT_INVALID" }));

    const scenarioId = human.test_scenarios.content.scenarios[0]?.scenario_id;
    if (scenarioId === undefined) throw new Error("missing scenario fixture");
    const mismatchedContent = { ...human.plan.content, tasks: human.plan.content.tasks.map((task, index) => index === 0 ?
      { ...task, scenario_refs: task.scenario_refs.filter((ref) => ref !== scenarioId) } : task) };
    const mismatchedHash = testHash({ artifact_type: "plan", content: mismatchedContent });
    const mismatchedPlan = { ...human.plan, content: mismatchedContent, content_hash: mismatchedHash,
      artifact_id: `plan_artifact:plan:${mismatchedHash.slice(7)}` };
    const mismatchedBody = { schema_version: 2 as const, design: human.design, plan: mismatchedPlan,
      test_scenarios: human.test_scenarios };
    const mismatchedSetHash = testHash(mismatchedBody);
    const mismatched = { ...mismatchedBody, artifact_set_hash: mismatchedSetHash,
      artifact_set_id: `plan_artifact_set:${mismatchedSetHash.slice(7)}` };
    expect(() => model.deriveMachineArtifacts({ schema_version: 2, profile: input.profile,
      phase_set: input.phase_set, capabilities: [], worktree_policy: "project_default", human_input: input,
      human: mismatched })).toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_INPUT_INVALID" }));
  });

  it("rebuilds trusted human inputs and rejects an objective edit even after every candidate hash is recomputed", () => {
    const model = createPlanArtifactModel();
    const input = trustedInput();
    const human = model.buildHumanArtifacts(input);
    const content = { ...human.plan.content, tasks: human.plan.content.tasks.map((task) =>
      task.task_id === "task:module" ? { ...task, objective: "人工篡改目标" } : task) };
    const content_hash = testHash({ artifact_type: "plan", content });
    const plan = { ...human.plan, content, content_hash,
      artifact_id: `plan_artifact:plan:${content_hash.slice("sha256:".length)}` };
    const body = { schema_version: 2 as const, design: human.design, plan, test_scenarios: human.test_scenarios };
    const artifact_set_hash = testHash(body);
    const forged = { ...body, artifact_set_hash,
      artifact_set_id: `plan_artifact_set:${artifact_set_hash.slice("sha256:".length)}` };
    expect(() => model.deriveMachineArtifacts({ schema_version: 2, profile: input.profile,
      phase_set: input.phase_set, capabilities: [], worktree_policy: "project_default", human_input: input,
      human: forged })).toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_INPUT_INVALID" }));
    expect(() => model.deriveImplementationDetail({ mode: input.profile.mode, human_input: input, human: forged }))
      .toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_INPUT_INVALID" }));
  });

  it("keeps quick detail short and derives richer standard/assurance views idempotently", () => {
    const model = createPlanArtifactModel();
    for (const mode of ["quick", "standard", "assurance"] as const) {
      const input = trustedInput(mode);
      const human = model.buildHumanArtifacts(input);
      const first = model.deriveImplementationDetail({ mode, human_input: input, human });
      const second = model.deriveImplementationDetail({ mode, human_input: input, human });
      expect(second).toEqual(first);
      expect(first.content).toMatchObject({ key_modifications: expect.any(Array), commands: expect.any(Array),
        boundaries: expect.any(Array) });
      if (mode === "quick") expect(first.content).not.toHaveProperty("interfaces");
      else expect(first.content).toHaveProperty("interfaces", expect.any(Array));
      if (mode === "assurance") expect(first.content).toMatchObject({ migration: expect.any(Array),
        failure_recovery: expect.any(Array), concurrency: expect.any(Array), permissions: expect.any(Array),
        rollback: expect.any(Array) });
    }
  });

  it("updates checkpoints and detail when plan changes and verifies the complete set", () => {
    const model = createPlanArtifactModel();
    const input = trustedInput();
    const human = model.buildHumanArtifacts(input);
    const machineInput = { schema_version: 2 as const, profile: input.profile, phase_set: input.phase_set,
      capabilities: ["api"] as const, worktree_policy: "required" as const };
    const machine = model.deriveMachineArtifacts({ ...machineInput, human_input: input, human });
    const detail = model.deriveImplementationDetail({ mode: input.profile.mode, human_input: input, human });
    expect(model.verifyArtifactSet({ human_input: input, human, machine_input: machineInput, machine, detail }))
      .toEqual({ valid: true, reason_code: "PLAN_ARTIFACT_SET_VALID" });
    const changedTasks = input.structured_input.tasks.map((task) => task.task_id === "task:module" ?
      { ...task, objective: "实现并冻结 PlanArtifactModel" } : task);
    const changedInput = { ...input, structured_input: { ...input.structured_input, tasks: changedTasks } };
    const changedHuman = model.buildHumanArtifacts(changedInput);
    const changedMachine = model.deriveMachineArtifacts({ ...machineInput, human_input: changedInput,
      human: changedHuman });
    const changedDetail = model.deriveImplementationDetail({ mode: input.profile.mode, human_input: changedInput,
      human: changedHuman });
    expect(changedMachine.implementation_checkpoints.content_hash).not.toBe(machine.implementation_checkpoints.content_hash);
    expect(changedDetail.content_hash).not.toBe(detail.content_hash);
    expect(model.verifyArtifactSet({ human_input: changedInput, human, machine_input: machineInput,
      machine: changedMachine, detail: changedDetail })).toEqual({ valid: false,
        reason_code: "PLAN_ARTIFACT_SOURCE_DRIFT" });
  });

  it("does not take the expected generator version from the candidate detail", () => {
    const model = createPlanArtifactModel();
    const input = trustedInput();
    const human = model.buildHumanArtifacts(input);
    const machineInput = { schema_version: 2 as const, profile: input.profile, phase_set: input.phase_set,
      capabilities: [] as const, worktree_policy: "project_default" as const };
    const machine = model.deriveMachineArtifacts({ ...machineInput, human_input: input, human });
    const detail = model.deriveImplementationDetail({ mode: input.profile.mode, human_input: input, human });
    expect(model.verifyArtifactSet({ human_input: input, human, machine_input: machineInput, machine,
      detail: { ...detail, generator_version: "evil-generator" } })).toEqual({ valid: false,
        reason_code: "PLAN_ARTIFACT_SET_INVALID" });
    expect(() => model.deriveImplementationDetail({ mode: input.profile.mode, human_input: input, human,
      generator_version: "evil-generator" } as never)).toThrowError(expect.objectContaining({
      code: "PLAN_ARTIFACT_INPUT_INVALID"
    }));
  });
});

describe("PlanArtifactModel compatibility and hostile records", () => {
  it("rejects schema v1 at every current build, derive, and verify boundary", () => {
    const model = createPlanArtifactModel(); const input = trustedInput();
    const human = model.buildHumanArtifacts(input);
    const legacyInput = { ...input, schema_version: 1 };
    expect(() => model.buildHumanArtifacts(legacyInput as never)).toThrowError(expect.objectContaining({
      code: "PLAN_ARTIFACT_INPUT_INVALID"
    }));
    expect(() => model.deriveMachineArtifacts({ schema_version: 1, profile: input.profile,
      phase_set: input.phase_set, capabilities: [], worktree_policy: "project_default", human_input: legacyInput,
      human } as never)).toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_INPUT_INVALID" }));
    expect(() => model.deriveImplementationDetail({ mode: input.profile.mode, human_input: legacyInput,
      human } as never)).toThrowError(expect.objectContaining({ code: "PLAN_ARTIFACT_INPUT_INVALID" }));
    expect(model.verifyArtifactSet({ human_input: legacyInput, human, machine_input: { schema_version: 1,
      profile: input.profile, phase_set: input.phase_set, capabilities: [], worktree_policy: "project_default" },
      machine: {}, detail: {} } as never)).toEqual({ valid: false, reason_code: "PLAN_ARTIFACT_SET_INVALID" });
  });

  it("keeps old frontmatter and six standard inputs read-only", async () => {
    const model = createPlanArtifactModel();
    const legacy = JSON.parse(await readFile(new URL("./fixtures/plan-artifacts-v0-legacy.json", import.meta.url), "utf8"));
    expect(model.normalizeLegacy(legacy)).toEqual({ ok: true, source_schema_version: 0,
      readiness: "legacy_read_only", legacy: { change_name: "legacy-change", frontmatter_status: "approved",
        standard_inputs: ["design.md", "plan.md", "implementation-detail.md", "test-scenarios.md",
          "gate-policy.json", "worktree.json"] } });
    expect(model.normalizeLegacy({ ...legacy, standardInputs: [...legacy.standardInputs].reverse() }))
      .toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_RECORD_INVALID" });
    expect(model.normalizeLegacy({ ...legacy, frontmatterStatus: "totally_untrusted" }))
      .toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_RECORD_INVALID" });
    expect(model.normalizeLegacy({ ...legacy, standardInputs: ["../escape", ...legacy.standardInputs.slice(1)] }))
      .toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_RECORD_INVALID" });
  });

  it("accepts only the exact v1 artifact shape as read-only", async () => {
    const model = createPlanArtifactModel();
    const fixture = JSON.parse(await readFile(new URL("./fixtures/plan-artifacts-v1-current.json", import.meta.url), "utf8"));
    const input = trustedInput();
    const human = model.buildHumanArtifacts(input);
    const stripTask = (task: typeof human.plan.content.tasks[number]) => withoutKeys(task,
      ["requirement_refs", "evidence_refs", "ownership_refs"]);
    const stripScenario = (scenarioValue: typeof human.test_scenarios.content.scenarios[number]) =>
      withoutKeys(scenarioValue, ["task_refs", "requirement_refs"]);
    const legacyContents = {
      design: withoutKeys(human.design.content, ["requirements", "approved_scopes", "ownership"]),
      plan: { change_key: fixture.structured_input.change_key,
        tasks: human.plan.content.tasks.map(stripTask) },
      test_scenarios: { scenarios: human.test_scenarios.content.scenarios.map(stripScenario),
        coverage: human.test_scenarios.content.coverage }
    };
    const legacyArtifact = (artifact_type: "design" | "plan" | "test_scenarios", content: unknown) => {
      const content_hash = testHash({ artifact_type, content });
      return { schema_version: 1, artifact_type, source_hashes: human.design.source_hashes,
        generator_version: "hunter-harness-plan-artifacts/1", content_hash,
        artifact_id: `plan_artifact:${artifact_type}:${content_hash.slice(7)}`, content };
    };
    const body = { schema_version: 1 as const,
      design: legacyArtifact("design", legacyContents.design),
      plan: legacyArtifact("plan", legacyContents.plan),
      test_scenarios: legacyArtifact("test_scenarios", legacyContents.test_scenarios) };
    const artifact_set_hash = testHash(body);
    const legacy = { ...body, artifact_set_hash,
      artifact_set_id: `plan_artifact_set:${artifact_set_hash.slice(7)}` };
    const rehashArtifact = (candidate: typeof legacy.design) => {
      const content_hash = testHash({ artifact_type: candidate.artifact_type, content: candidate.content });
      return { ...candidate, content_hash,
        artifact_id: `plan_artifact:${candidate.artifact_type}:${content_hash.slice(7)}` };
    };
    const rehashSet = (candidate: typeof legacy) => {
      const nextBody = { schema_version: 1 as const, design: rehashArtifact(candidate.design),
        plan: rehashArtifact(candidate.plan), test_scenarios: rehashArtifact(candidate.test_scenarios) };
      const nextHash = testHash(nextBody);
      return { ...nextBody, artifact_set_hash: nextHash,
        artifact_set_id: `plan_artifact_set:${nextHash.slice(7)}` };
    };
    expect(model.normalizeLegacy(legacy)).toMatchObject({ ok: true,
      source_schema_version: 1, readiness: "legacy_read_only" });
    expect(model.normalizeLegacy(rehashSet({ ...legacy, design: { ...legacy.design,
      generator_version: MODULE_GENERATOR_VERSION } } as typeof legacy))).toEqual({ ok: false,
        reason_code: "PLAN_ARTIFACT_RECORD_INVALID" });
    expect(model.normalizeLegacy(rehashSet({ ...legacy, design: { ...legacy.design,
      content: { ...legacy.design.content, requirements: input.structured_input.requirements } } })))
      .toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_RECORD_INVALID" });
    expect(model.normalizeLegacy(rehashSet({ ...legacy, plan: { ...legacy.plan, content: { ...legacy.plan.content,
      tasks: [{ ...legacy.plan.content.tasks[0], requirement_refs: input.structured_input.requirements.map(
        (item) => item.requirement_id) }, ...legacy.plan.content.tasks.slice(1)] } } })))
      .toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_RECORD_INVALID" });
  });

  it("keeps the v2 semantic-contract fixture canonical and reproducible", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/plan-artifacts-v2-current.json", import.meta.url), "utf8"));
    const input = trustedInput();
    expect(fixture.schema_version).toBe(2);
    expect(input.structured_input.requirements).toEqual(fixture.semantic_contract.requirements);
    expect(input.structured_input.approved_scopes).toEqual(fixture.semantic_contract.approved_scopes);
    expect(input.structured_input.ownership?.[0]).toEqual(fixture.semantic_contract.ownership[0]);
    expect(createPlanArtifactModel().buildHumanArtifacts(input)).toMatchObject({ schema_version: 2,
      design: { content: { requirements: fixture.semantic_contract.requirements } } });
  });

  it("normalizes current only against trusted sources and rejects self-hash/source drift", () => {
    const model = createPlanArtifactModel();
    const input = trustedInput();
    const human = model.buildHumanArtifacts(input);
    expect(model.normalizeLegacy(human)).toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_RECORD_INVALID" });
    expect(model.normalizeLegacy(human, input)).toMatchObject({ ok: true, readiness: "current" });
    expect(model.normalizeLegacy({ ...human, design: { ...human.design, content: { ...human.design.content,
      goal: "篡改目标" } } }, input)).toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_RECORD_INVALID" });
  });

  it("does not execute accessors at any public boundary", () => {
    const model = createPlanArtifactModel();
    let probes = 0;
    const hostile = Object.defineProperty({}, "schema_version", { enumerable: true,
      get() { probes += 1; return 1; } });
    expect(() => model.buildHumanArtifacts(hostile as never)).toThrowError(expect.objectContaining({
      code: "PLAN_ARTIFACT_INPUT_INVALID"
    }));
    expect(model.normalizeLegacy(hostile)).toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_RECORD_INVALID" });
    expect(probes).toBe(0);
  });
});
