import { PLAN_PHASES, planProfileSchema, plannedPhaseSetSchema } from "../plan-classification/index.js";
import { createPlanDecisionModule } from "../plan-decision/index.js";
import { PlanArtifactError } from "./errors.js";
import {
  bounded,
  canonicalPath,
  compareCodepoint,
  deepFreeze,
  exact,
  plainRecord,
  snapshotData,
  sortedUnique,
  stableHash,
  stringArray
} from "./stable.js";
import type {
  ArtifactIdentity,
  ArtifactSetVerification,
  CoverageApplicabilityInput,
  CoverageDimension,
  DesignArtifact,
  HumanArtifactBuildInput,
  HumanArtifactSet,
  ImplementationDetailArtifact,
  LegacyV1HumanArtifactSet,
  MachineArtifact,
  MachineArtifactDerivationInput,
  MachineArtifactSet,
  PlanArtifact,
  PlanArtifactModel,
  PlanTaskInput,
  TestScenarioInput,
  TestScenariosArtifact
} from "./types.js";
import type { ApprovedScopeRecord, OwnershipRecord, RequirementRecord } from "./types.js";

const coverageDimensions: readonly CoverageDimension[] = [
  "business_rules", "concurrency_idempotency", "data_compatibility", "error_codes",
  "integration_impact", "normal_path", "parameter_validation", "permission_boundaries"
];
const capabilities = ["api", "concurrency", "database", "filesystem", "migration", "network",
  "permissions", "security", "ui"] as const;
export const MODULE_GENERATOR_VERSION = "hunter-harness-plan-artifacts/3" as const;
const LEGACY_GENERATOR_VERSION = "hunter-harness-plan-artifacts/1" as const;
const SCENARIO_PRIORITIES = ["P0", "P1", "P2"] as const;
// 与 harness_plan_finalize.PRIORITY_EVIDENCE_KIND 同表。派生进 manifest 而不是留给
// Python 端算：让 artifact 自描述，消费侧只做纯改名，两边不会各推一套映射。
const PRIORITY_EVIDENCE_KIND: Readonly<Record<string, "ledger" | "advisory">> = {
  P0: "ledger", P1: "ledger", P2: "advisory"
};

function fail(code: ConstructorParameters<typeof PlanArtifactError>[0]): never {
  throw new PlanArtifactError(code);
}

function snap<T>(input: unknown): T {
  try { return snapshotData(input) as T; } catch { return fail("PLAN_ARTIFACT_INPUT_INVALID"); }
}

function artifact<T extends string, C>(type: T, sourceHashes: Readonly<Record<string, string>>,
  content: C): ArtifactIdentity &
  { readonly artifact_type: T; readonly content: C } {
  const content_hash = stableHash({ artifact_type: type, content });
  return deepFreeze({
    schema_version: 2,
    artifact_type: type,
    source_hashes: { ...sourceHashes },
    generator_version: MODULE_GENERATOR_VERSION,
    content_hash,
    artifact_id: `plan_artifact:${type}:${content_hash.slice("sha256:".length)}`,
    content
  });
}

function validTask(value: unknown): value is PlanTaskInput {
  return plainRecord(value) && exact(value, ["task_id", "objective", "affected_paths", "depends_on",
    "owner_phase", "decision_refs", "scenario_refs", "requirement_refs", "evidence_refs", "ownership_refs"]) &&
    bounded(value.task_id, 128) &&
    bounded(value.objective, 2_048) && stringArray(value.affected_paths, 1, 64, 512) &&
    value.affected_paths.every(canonicalPath) && stringArray(value.depends_on, 0, 64, 128) &&
    typeof value.owner_phase === "string" && PLAN_PHASES.includes(value.owner_phase as never) &&
    stringArray(value.decision_refs, 0, 64, 160) && stringArray(value.scenario_refs, 1, 64, 128) &&
    stringArray(value.requirement_refs, 1, 128, 160) && stringArray(value.evidence_refs, 1, 128, 256) &&
    stringArray(value.ownership_refs, 1, 128, 160);
}

function validScenario(value: unknown): value is TestScenarioInput {
  return plainRecord(value) && exact(value, ["scenario_id", "title", "acceptance", "coverage_dimension",
    "execution_level", "evidence_requirements", "risk_level", "priority", "owner_phase",
    "task_refs", "requirement_refs"],
    ["verification_command", "executable_test_id", "test_file", "test_title"]) &&
    bounded(value.scenario_id, 128) && bounded(value.title, 512) && bounded(value.acceptance, 2_048) &&
    typeof value.coverage_dimension === "string" && coverageDimensions.includes(value.coverage_dimension as never) &&
    typeof value.execution_level === "string" && ["unit", "api", "data_compatibility", "integration", "system"]
      .includes(value.execution_level) && stringArray(value.evidence_requirements, 1, 16, 1_024) &&
    (value.verification_command === undefined || bounded(value.verification_command, 1_024)) &&
    typeof value.risk_level === "string" && ["low", "medium", "high"].includes(value.risk_level) &&
    typeof value.priority === "string" && SCENARIO_PRIORITIES.includes(value.priority as never) &&
    typeof value.owner_phase === "string" && PLAN_PHASES.includes(value.owner_phase as never) &&
    (value.executable_test_id === undefined || bounded(value.executable_test_id, 512)) &&
    (value.test_file === undefined || bounded(value.test_file, 512)) &&
    (value.test_title === undefined || bounded(value.test_title, 512)) &&
    stringArray(value.task_refs, 1, 128, 160) && stringArray(value.requirement_refs, 1, 128, 160);
}

function validRequirement(value: unknown): value is RequirementRecord {
  return plainRecord(value) && exact(value, ["requirement_id", "kind", "text", "evidence_refs",
    "approved_scope_refs"]) && bounded(value.requirement_id, 160) && typeof value.kind === "string" &&
    ["behavior", "invariant", "failure_behavior"].includes(value.kind) && bounded(value.text, 4_096) &&
    stringArray(value.evidence_refs, 1, 128, 256) && stringArray(value.approved_scope_refs, 1, 128, 160) &&
    value.requirement_id === `requirement:${stableHash({ kind: value.kind, text: value.text,
      evidence_refs: value.evidence_refs, approved_scope_refs: value.approved_scope_refs }).slice(7)}`;
}

function validScope(value: unknown): value is ApprovedScopeRecord {
  return plainRecord(value) && exact(value, ["scope_ref", "text"]) && bounded(value.text, 2_048) &&
    value.scope_ref === `scope:${stableHash({ text: value.text }).slice(7)}`;
}

function validOwnership(value: unknown): value is OwnershipRecord {
  return plainRecord(value) && exact(value, ["ownership_ref", "path", "approved_scope_refs", "evidence_refs"]) &&
    bounded(value.path, 512) && canonicalPath(value.path) && stringArray(value.approved_scope_refs, 1, 128, 160) &&
    stringArray(value.evidence_refs, 1, 128, 256) && value.ownership_ref === `ownership:${stableHash({ path: value.path,
      approved_scope_refs: value.approved_scope_refs, evidence_refs: value.evidence_refs }).slice(7)}`;
}

function evidenceRefSet(input: HumanArtifactBuildInput): ReadonlySet<string> {
  return new Set([...(input.evidence.modules.map((value) => `module:${value}`)),
    ...(input.evidence.symbols.map((value) => `symbol:${value}`)),
    ...(input.evidence.consumers.map((value) => `consumer:${value}`)),
    ...(input.evidence.tests.map((value) => `test:${value}`)),
    ...(input.evidence.constraints.map((value) => `constraint:${value}`)),
    ...(input.evidence.source_refs.map((value) => `source:${value.source_id}`))]);
}

function validCoverage(value: unknown): value is CoverageApplicabilityInput {
  if (!plainRecord(value) || !exact(value, ["coverage_dimension", "applicability", "scenario_refs"],
    ["not_applicable_reason"]) || typeof value.coverage_dimension !== "string" ||
    !coverageDimensions.includes(value.coverage_dimension as never) || typeof value.applicability !== "string" ||
    !["applicable", "not_applicable"].includes(value.applicability) || !stringArray(value.scenario_refs, 0, 64, 128)) return false;
  return value.applicability === "applicable" ? value.scenario_refs.length > 0 && value.not_applicable_reason === undefined :
    value.scenario_refs.length === 0 && bounded(value.not_applicable_reason, 1_024);
}

function validateStructured(input: HumanArtifactBuildInput): void {
  const structured = input.structured_input;
  if (!plainRecord(structured) || !exact(structured, ["change_key", "tasks", "scenarios", "coverage",
    "requirements", "approved_scopes", "ownership"]) ||
      !bounded(structured.change_key, 160) || !Array.isArray(structured.tasks) || structured.tasks.length === 0 ||
      structured.tasks.length > 128 || !structured.tasks.every(validTask) || !Array.isArray(structured.scenarios) ||
      structured.scenarios.length < 3 || structured.scenarios.length > 128 || !structured.scenarios.every(validScenario) ||
      !Array.isArray(structured.coverage) || structured.coverage.length !== coverageDimensions.length ||
      !structured.coverage.every(validCoverage) || !Array.isArray(structured.requirements) ||
      structured.requirements.length < 3 ||
      structured.requirements.length > 128 || !structured.requirements.every(validRequirement) ||
      !Array.isArray(structured.approved_scopes) || structured.approved_scopes.length === 0 ||
      structured.approved_scopes.length > 128 || !structured.approved_scopes.every(validScope) ||
      !Array.isArray(structured.ownership) || structured.ownership.length === 0 || structured.ownership.length > 256 ||
      !structured.ownership.every(validOwnership)) fail("PLAN_ARTIFACT_INPUT_INVALID");
  const taskIds = structured.tasks.map((task) => task.task_id);
  const scenarioIds = structured.scenarios.map((scenario) => scenario.scenario_id);
  const decisionIds = new Set(input.graph.nodes.map((node) => node.decision_id));
  if (new Set(taskIds).size !== taskIds.length || new Set(scenarioIds).size !== scenarioIds.length ||
      JSON.stringify(structured.coverage.map((item) => item.coverage_dimension)) !== JSON.stringify(coverageDimensions) ||
      structured.tasks.some((task) => !input.phase_set.planned_phases.includes(task.owner_phase) ||
        task.depends_on.some((id) => !taskIds.includes(id) || id === task.task_id) ||
        task.decision_refs.some((id) => !decisionIds.has(id)) || task.scenario_refs.some((id) => !scenarioIds.includes(id))) ||
      structured.coverage.some((item) => item.scenario_refs.some((id) => !scenarioIds.includes(id)) ||
        item.scenario_refs.some((id) => structured.scenarios.find((scenario) => scenario.scenario_id === id)
          ?.coverage_dimension !== item.coverage_dimension)) ||
      structured.scenarios.some((scenario) => !structured.coverage.some((item) =>
        item.coverage_dimension === scenario.coverage_dimension && item.applicability === "applicable" &&
        item.scenario_refs.includes(scenario.scenario_id)))) fail("PLAN_ARTIFACT_REFERENCE_INVALID");
  {
    const requirements = structured.requirements;
    const scopes = structured.approved_scopes;
    const ownership = structured.ownership;
    const requirementIds = requirements.map((item) => item.requirement_id);
    const scopeIds = scopes.map((item) => item.scope_ref);
    const ownershipIds = ownership.map((item) => item.ownership_ref);
    const allowedEvidence = evidenceRefSet(input);
    const expectedRequirementTexts = [{ kind: "behavior", values: [input.approval_package.sections.design.recommended_design] },
      { kind: "invariant", values: input.approval_package.sections.boundaries.invariants },
      { kind: "failure_behavior", values: input.approval_package.sections.boundaries.failure_behaviors }];
    if (new Set(requirementIds).size !== requirementIds.length || new Set(scopeIds).size !== scopeIds.length ||
        new Set(ownershipIds).size !== ownershipIds.length || !same(requirements, [...requirements].sort((left, right) =>
          ["behavior", "invariant", "failure_behavior"].indexOf(left.kind) -
          ["behavior", "invariant", "failure_behavior"].indexOf(right.kind) ||
          compareCodepoint(left.requirement_id, right.requirement_id))) || !same(scopes.map((item) => item.text),
          [...scopes.map((item) => item.text)].sort(compareCodepoint)) || !same(ownership.map((item) => item.path),
          [...ownership.map((item) => item.path)].sort(compareCodepoint)) ||
        requirements.some((item) => !same(item.evidence_refs, sortedUnique(item.evidence_refs)) ||
          !same(item.approved_scope_refs, sortedUnique(item.approved_scope_refs))) || ownership.some((item) =>
          !same(item.evidence_refs, sortedUnique(item.evidence_refs)) ||
          !same(item.approved_scope_refs, sortedUnique(item.approved_scope_refs))) ||
        new Set(ownership.map((item) => item.path)).size !== ownership.length ||
        !same(scopes.map((item) => item.text).sort(compareCodepoint),
          [...input.intent.in_scope].sort(compareCodepoint)) || expectedRequirementTexts.some((group) =>
          !same(requirements.filter((item) => item.kind === group.kind).map((item) => item.text).sort(compareCodepoint),
            [...group.values].sort(compareCodepoint))) || requirements.some((item) =>
          item.approved_scope_refs.some((ref) => !scopeIds.includes(ref)) || item.evidence_refs.some((ref) =>
            !allowedEvidence.has(ref))) || ownership.some((item) => item.approved_scope_refs.some((ref) =>
          !scopeIds.includes(ref)) || item.evidence_refs.some((ref) => !allowedEvidence.has(ref))) ||
        structured.tasks.some((task) => task.requirement_refs.some((ref) => !requirementIds.includes(ref)) ||
          task.evidence_refs.some((ref) => !allowedEvidence.has(ref)) || task.ownership_refs.some((ref) =>
            !ownershipIds.includes(ref)) || task.affected_paths.some((affectedPath) => !ownership.some((item) =>
            item.path === affectedPath && task.ownership_refs.includes(item.ownership_ref)))) ||
        structured.scenarios.some((scenario) => scenario.task_refs.some((ref) => !taskIds.includes(ref)) ||
          scenario.requirement_refs.some((ref) => !requirementIds.includes(ref))) || requirements.some((requirement) =>
          !structured.tasks.some((task) => task.requirement_refs.includes(requirement.requirement_id)) ||
          !structured.scenarios.some((scenario) => scenario.requirement_refs.includes(requirement.requirement_id))) ||
        structured.tasks.some((task) => !same(sortedUnique(task.scenario_refs), structured.scenarios.filter((scenario) =>
          scenario.task_refs.includes(task.task_id)).map((scenario) => scenario.scenario_id).sort(compareCodepoint)) ||
          task.requirement_refs.some((requirementRef) => !structured.scenarios.some((scenario) =>
            task.scenario_refs.includes(scenario.scenario_id) && scenario.requirement_refs.includes(requirementRef)))) ||
        structured.scenarios.some((scenario) => !scenario.requirement_refs.every((requirementRef) =>
          scenario.task_refs.some((taskRef) => structured.tasks.find((task) => task.task_id === taskRef)
            ?.requirement_refs.includes(requirementRef))))) {
      fail("PLAN_ARTIFACT_REFERENCE_INVALID");
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byTask = new Map(structured.tasks.map((task) => [task.task_id, task]));
  function cyclic(id: string): boolean {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    if ((byTask.get(id)?.depends_on ?? []).some(cyclic)) return true;
    visiting.delete(id); done.add(id); return false;
  }
  if (taskIds.some(cyclic)) fail("PLAN_ARTIFACT_REFERENCE_INVALID");
}

function orderedTasks(tasks: readonly PlanTaskInput[]): readonly PlanTaskInput[] {
  const remaining = new Map(tasks.map((task) => [task.task_id, task]));
  const emitted = new Set<string>();
  const result: PlanTaskInput[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((task) => task.depends_on.every((id) => emitted.has(id)))
      .sort((left, right) => compareCodepoint(left.task_id, right.task_id));
    if (ready.length === 0) return fail("PLAN_ARTIFACT_REFERENCE_INVALID");
    for (const task of ready) { result.push(task); emitted.add(task.task_id); remaining.delete(task.task_id); }
  }
  return result;
}

const shaPattern = /^sha256:[0-9a-f]{64}$/u;
const humanSourceKeys = ["approval_package", "approval_receipt", "decision_graph", "evidence_map",
  "intent_contract", "plan_profile", "planned_phase_set", "planning_context", "structured_input"] as const;

function validIdentity(value: unknown, type: string): value is ArtifactIdentity & { content: unknown } {
  if (!plainRecord(value) || !exact(value, ["schema_version", "artifact_id", "artifact_type", "source_hashes",
    "generator_version", "content_hash", "content"]) || value.schema_version !== 2 || value.artifact_type !== type ||
    value.generator_version !== MODULE_GENERATOR_VERSION || typeof value.content_hash !== "string" ||
    !shaPattern.test(value.content_hash) || value.content_hash !== stableHash({ artifact_type: type, content: value.content }) ||
    value.artifact_id !== `plan_artifact:${type}:${value.content_hash.slice("sha256:".length)}` ||
    !plainRecord(value.source_hashes) || !exact(value.source_hashes, [...humanSourceKeys]) ||
    !Object.values(value.source_hashes).every((hash) => typeof hash === "string" && shaPattern.test(hash))) return false;
  return true;
}

function validHumanSet(value: unknown): value is HumanArtifactSet {
  if (!plainRecord(value) || !exact(value, ["schema_version", "artifact_set_id", "artifact_set_hash", "design",
    "plan", "test_scenarios"]) || value.schema_version !== 2 || !validIdentity(value.design, "design") ||
    !validIdentity(value.plan, "plan") || !validIdentity(value.test_scenarios, "test_scenarios")) return false;
  const design = value.design as unknown as DesignArtifact;
  const plan = value.plan as unknown as PlanArtifact;
  const tests = value.test_scenarios as unknown as TestScenariosArtifact;
  if (!plainRecord(design.content) || !exact(design.content, ["goal", "user_visible_outcome", "in_scope",
    "out_of_scope", "behavior_contract", "constraints", "invariants", "failure_behaviors", "tradeoffs",
    "compatibility_boundaries", "risks", "requirements", "approved_scopes", "ownership"]) ||
    !bounded(design.content.goal, 4_096) ||
    !bounded(design.content.user_visible_outcome, 4_096) || !bounded(design.content.behavior_contract, 8_192) ||
    !stringArray(design.content.in_scope, 0, 128) || !stringArray(design.content.out_of_scope, 0, 128) ||
    !stringArray(design.content.constraints, 0, 128) || !stringArray(design.content.invariants, 0, 128) ||
    !stringArray(design.content.failure_behaviors, 0, 128) || !stringArray(design.content.tradeoffs, 0, 128) ||
    !stringArray(design.content.compatibility_boundaries, 0, 128) || !Array.isArray(design.content.risks) ||
    design.content.risks.length > 128 || !design.content.risks.every((risk) => plainRecord(risk) &&
      exact(risk, ["risk", "mitigation"]) && bounded(risk.risk, 2_048) && bounded(risk.mitigation, 2_048)) ||
    !plainRecord(plan.content) || !exact(plan.content, ["change_key", "tasks"]) ||
    !bounded(plan.content.change_key, 160) || !Array.isArray(plan.content.tasks) || plan.content.tasks.length === 0 ||
    plan.content.tasks.length > 128 || !plan.content.tasks.every(validTask) || !plainRecord(tests.content) ||
    !exact(tests.content, ["scenarios", "coverage"]) || !Array.isArray(tests.content.scenarios) ||
    tests.content.scenarios.length < 3 || tests.content.scenarios.length > 128 ||
    !tests.content.scenarios.every(validScenario) || !Array.isArray(tests.content.coverage) ||
    tests.content.coverage.length !== coverageDimensions.length || !tests.content.coverage.every(validCoverage) ||
    design.schema_version !== value.schema_version || plan.schema_version !== value.schema_version ||
    tests.schema_version !== value.schema_version) return false;
  if (!Array.isArray(design.content.requirements) ||
    !design.content.requirements.every(validRequirement) || !Array.isArray(design.content.approved_scopes) ||
    !design.content.approved_scopes.every(validScope) || !Array.isArray(design.content.ownership) ||
    !design.content.ownership.every(validOwnership)) return false;
  if (!same(design.source_hashes, plan.source_hashes) || !same(design.source_hashes, tests.source_hashes)) return false;
  const taskIds = plan.content.tasks.map((task) => task.task_id);
  const scenarioIds = tests.content.scenarios.map((scenario) => scenario.scenario_id);
  if (new Set(taskIds).size !== taskIds.length || new Set(scenarioIds).size !== scenarioIds.length ||
    JSON.stringify(tests.content.coverage.map((item) => item.coverage_dimension)) !== JSON.stringify(coverageDimensions) ||
    plan.content.tasks.some((task) => task.depends_on.some((id) => !taskIds.includes(id) || id === task.task_id) ||
      task.scenario_refs.some((id) => !scenarioIds.includes(id))) || tests.content.coverage.some((item) =>
      item.scenario_refs.some((id) => !scenarioIds.includes(id)) || item.scenario_refs.some((id) =>
        tests.content.scenarios.find((scenario) => scenario.scenario_id === id)?.coverage_dimension !==
          item.coverage_dimension))) return false;
  const pending = new Set(taskIds);
  while (pending.size > 0) {
    const ready = plan.content.tasks.filter((task) => pending.has(task.task_id) &&
      task.depends_on.every((id) => !pending.has(id)));
    if (ready.length === 0) return false;
    for (const task of ready) pending.delete(task.task_id);
  }
  const body = { schema_version: value.schema_version, design, plan, test_scenarios: tests };
  const setHash = stableHash(body);
  return value.artifact_set_hash === setHash && value.artifact_set_id ===
    `plan_artifact_set:${setHash.slice("sha256:".length)}` &&
    new Set([design.artifact_id, plan.artifact_id, tests.artifact_id]).size === 3;
}

function validLegacyV1Task(value: unknown): boolean {
  return plainRecord(value) && exact(value, ["task_id", "objective", "affected_paths", "depends_on",
    "owner_phase", "decision_refs", "scenario_refs"]) && bounded(value.task_id, 128) &&
    bounded(value.objective, 2_048) && stringArray(value.affected_paths, 1, 64, 512) &&
    value.affected_paths.every(canonicalPath) && stringArray(value.depends_on, 0, 64, 128) &&
    typeof value.owner_phase === "string" && PLAN_PHASES.includes(value.owner_phase as never) &&
    stringArray(value.decision_refs, 0, 64, 160) && stringArray(value.scenario_refs, 1, 64, 128);
}

function validLegacyV1Scenario(value: unknown): boolean {
  return plainRecord(value) && exact(value, ["scenario_id", "title", "acceptance", "coverage_dimension",
    "execution_level", "evidence_requirements", "risk_level"], ["verification_command"]) &&
    bounded(value.scenario_id, 128) && bounded(value.title, 512) && bounded(value.acceptance, 2_048) &&
    typeof value.coverage_dimension === "string" && coverageDimensions.includes(value.coverage_dimension as never) &&
    typeof value.execution_level === "string" && ["unit", "api", "data_compatibility", "integration", "system"]
      .includes(value.execution_level) && stringArray(value.evidence_requirements, 1, 16, 1_024) &&
    (value.verification_command === undefined || bounded(value.verification_command, 1_024)) &&
    typeof value.risk_level === "string" && ["low", "medium", "high"].includes(value.risk_level);
}

function validLegacyV1Identity(value: unknown, type: "design" | "plan" | "test_scenarios"): boolean {
  return plainRecord(value) && exact(value, ["schema_version", "artifact_id", "artifact_type", "source_hashes",
    "generator_version", "content_hash", "content"]) && value.schema_version === 1 &&
    value.artifact_type === type && value.generator_version === LEGACY_GENERATOR_VERSION &&
    typeof value.content_hash === "string" && shaPattern.test(value.content_hash) &&
    value.content_hash === stableHash({ artifact_type: type, content: value.content }) &&
    value.artifact_id === `plan_artifact:${type}:${value.content_hash.slice("sha256:".length)}` &&
    plainRecord(value.source_hashes) && exact(value.source_hashes, [...humanSourceKeys]) &&
    Object.values(value.source_hashes).every((hash) => typeof hash === "string" && shaPattern.test(hash));
}

function validLegacyV1HumanSet(value: unknown): value is LegacyV1HumanArtifactSet {
  if (!plainRecord(value) || !exact(value, ["schema_version", "artifact_set_id", "artifact_set_hash", "design",
    "plan", "test_scenarios"]) || value.schema_version !== 1 || !validLegacyV1Identity(value.design, "design") ||
    !validLegacyV1Identity(value.plan, "plan") || !validLegacyV1Identity(value.test_scenarios, "test_scenarios")) {
    return false;
  }
  const design = value.design as unknown as { readonly source_hashes: Readonly<Record<string, string>>;
    readonly artifact_id: string; readonly content: Readonly<Record<string, unknown>> };
  const plan = value.plan as unknown as { readonly source_hashes: Readonly<Record<string, string>>;
    readonly artifact_id: string; readonly content: Readonly<Record<string, unknown>> };
  const tests = value.test_scenarios as unknown as { readonly source_hashes: Readonly<Record<string, string>>;
    readonly artifact_id: string; readonly content: Readonly<Record<string, unknown>> };
  if (!plainRecord(design.content) || !exact(design.content, ["goal", "user_visible_outcome", "in_scope",
    "out_of_scope", "behavior_contract", "constraints", "invariants", "failure_behaviors", "tradeoffs",
    "compatibility_boundaries", "risks"]) || !bounded(design.content.goal, 4_096) ||
    !bounded(design.content.user_visible_outcome, 4_096) || !bounded(design.content.behavior_contract, 8_192) ||
    !stringArray(design.content.in_scope, 0, 128) || !stringArray(design.content.out_of_scope, 0, 128) ||
    !stringArray(design.content.constraints, 0, 128) || !stringArray(design.content.invariants, 0, 128) ||
    !stringArray(design.content.failure_behaviors, 0, 128) || !stringArray(design.content.tradeoffs, 0, 128) ||
    !stringArray(design.content.compatibility_boundaries, 0, 128) || !Array.isArray(design.content.risks) ||
    design.content.risks.length > 128 || !design.content.risks.every((risk) => plainRecord(risk) &&
      exact(risk, ["risk", "mitigation"]) && bounded(risk.risk, 2_048) && bounded(risk.mitigation, 2_048)) ||
    !plainRecord(plan.content) || !exact(plan.content, ["change_key", "tasks"]) ||
    !bounded(plan.content.change_key, 160) || !Array.isArray(plan.content.tasks) || plan.content.tasks.length === 0 ||
    plan.content.tasks.length > 128 || !plan.content.tasks.every(validLegacyV1Task) || !plainRecord(tests.content) ||
    !exact(tests.content, ["scenarios", "coverage"]) || !Array.isArray(tests.content.scenarios) ||
    tests.content.scenarios.length < 3 || tests.content.scenarios.length > 128 ||
    !tests.content.scenarios.every(validLegacyV1Scenario) || !Array.isArray(tests.content.coverage) ||
    tests.content.coverage.length !== coverageDimensions.length || !tests.content.coverage.every(validCoverage) ||
    !same(design.source_hashes, plan.source_hashes) || !same(design.source_hashes, tests.source_hashes)) return false;
  const tasks = plan.content.tasks as readonly { readonly task_id: string; readonly depends_on: readonly string[];
    readonly scenario_refs: readonly string[] }[];
  const scenarios = tests.content.scenarios as readonly { readonly scenario_id: string;
    readonly coverage_dimension: CoverageDimension }[];
  const coverage = tests.content.coverage as readonly CoverageApplicabilityInput[];
  const taskIds = tasks.map((task) => task.task_id); const scenarioIds = scenarios.map((scenario) => scenario.scenario_id);
  if (new Set(taskIds).size !== taskIds.length || new Set(scenarioIds).size !== scenarioIds.length ||
    !same(coverage.map((item) => item.coverage_dimension), coverageDimensions) || tasks.some((task) =>
      task.depends_on.some((id) => !taskIds.includes(id) || id === task.task_id) ||
      task.scenario_refs.some((id) => !scenarioIds.includes(id))) || coverage.some((item) =>
      item.scenario_refs.some((id) => !scenarioIds.includes(id)) || item.scenario_refs.some((id) =>
        scenarios.find((scenario) => scenario.scenario_id === id)?.coverage_dimension !== item.coverage_dimension))) {
    return false;
  }
  const pending = new Set(taskIds);
  while (pending.size > 0) {
    const ready = tasks.filter((task) => pending.has(task.task_id) && task.depends_on.every((id) => !pending.has(id)));
    if (ready.length === 0) return false;
    for (const task of ready) pending.delete(task.task_id);
  }
  const body = { schema_version: 1, design: value.design, plan: value.plan, test_scenarios: value.test_scenarios };
  const setHash = stableHash(body);
  return value.artifact_set_hash === setHash && value.artifact_set_id ===
    `plan_artifact_set:${setHash.slice("sha256:".length)}` &&
    new Set([design.artifact_id, plan.artifact_id, tests.artifact_id]).size === 3;
}

function humanSources(input: HumanArtifactBuildInput): Readonly<Record<string, string>> {
  return deepFreeze({
    approval_package: stableHash(input.approval_package),
    approval_receipt: stableHash(input.approval_receipt),
    decision_graph: stableHash(input.graph),
    evidence_map: stableHash(input.evidence),
    intent_contract: stableHash(input.intent),
    plan_profile: stableHash(input.profile),
    planned_phase_set: stableHash(input.phase_set),
    planning_context: stableHash(input.context),
    structured_input: stableHash(input.structured_input)
  });
}

function buildHumanArtifactsCanonical(input: HumanArtifactBuildInput): HumanArtifactSet {
  if (!plainRecord(input) || !exact(input, ["schema_version", "profile", "phase_set", "context", "intent",
    "evidence", "graph", "approval_package", "approval_package_input", "approval_receipt", "structured_input",
    ]) || input.schema_version !== 2 ||
    !planProfileSchema.safeParse(input.profile).success || !plannedPhaseSetSchema.safeParse(input.phase_set).success) {
    return fail("PLAN_ARTIFACT_INPUT_INVALID");
  }
  const approval = createPlanDecisionModule().verifyApprovalReceipt({ receipt: input.approval_receipt,
    package: input.approval_package, profile: input.profile, phase_set: input.phase_set, context: input.context,
    intent: input.intent, evidence: input.evidence, graph: input.graph, package_input: input.approval_package_input });
  if (!approval.valid || input.approval_receipt.outcome !== "approved" || approval.approved_design_document === null) {
    return fail("PLAN_ARTIFACT_APPROVAL_INVALID");
  }
  validateStructured(input);
  const sources = humanSources(input);
  const sections = input.approval_package.sections;
  const semantic = {
    requirements: input.structured_input.requirements,
    approved_scopes: input.structured_input.approved_scopes,
    ownership: input.structured_input.ownership
  };
  const design = artifact("design", sources, {
    goal: sections.goal_and_outcome.goal,
    user_visible_outcome: sections.goal_and_outcome.user_visible_outcome,
    in_scope: [...sections.scope.in_scope], out_of_scope: [...sections.scope.out_of_scope],
    behavior_contract: sections.design.recommended_design,
    constraints: [...input.intent.constraints], invariants: [...sections.boundaries.invariants],
    failure_behaviors: [...sections.boundaries.failure_behaviors],
    tradeoffs: [...sections.design.key_alternatives],
    compatibility_boundaries: [...sections.boundaries.compatibility_boundaries],
    risks: sections.risks.map((risk) => ({ ...risk })), ...semantic
  }) as DesignArtifact;
  const tasks = orderedTasks(input.structured_input.tasks.map((task) => ({ ...task,
    affected_paths: sortedUnique(task.affected_paths), depends_on: sortedUnique(task.depends_on),
    decision_refs: sortedUnique(task.decision_refs), scenario_refs: sortedUnique(task.scenario_refs),
    requirement_refs: sortedUnique(task.requirement_refs), evidence_refs: sortedUnique(task.evidence_refs),
    ownership_refs: sortedUnique(task.ownership_refs) })));
  const plan = artifact("plan", sources,
    { change_key: input.structured_input.change_key, tasks }) as PlanArtifact;
  const scenarios = input.structured_input.scenarios.map((scenario) => ({ ...scenario,
    evidence_requirements: sortedUnique(scenario.evidence_requirements),
    task_refs: sortedUnique(scenario.task_refs), requirement_refs: sortedUnique(scenario.requirement_refs) }))
    .sort((left, right) => compareCodepoint(left.scenario_id, right.scenario_id));
  const coverage = input.structured_input.coverage.map((item) => ({ ...item,
    scenario_refs: sortedUnique(item.scenario_refs) }));
  const test_scenarios = artifact("test_scenarios", sources,
    { scenarios, coverage }) as TestScenariosArtifact;
  const body = { schema_version: 2 as const, design, plan, test_scenarios };
  const artifact_set_hash = stableHash(body);
  return deepFreeze({ ...body, artifact_set_hash,
    artifact_set_id: `plan_artifact_set:${artifact_set_hash.slice("sha256:".length)}` });
}

function machineArtifact(type: MachineArtifact["artifact_type"], human: HumanArtifactSet,
  content: Readonly<Record<string, unknown>>,
  derivationSources: Readonly<Record<string, string>> = {}): MachineArtifact {
  return artifact(type, {
    design: human.design.content_hash,
    plan: human.plan.content_hash,
    test_scenarios: human.test_scenarios.content_hash,
    ...derivationSources
  }, content) as MachineArtifact;
}

function deriveMachineArtifactsCanonical(input: MachineArtifactDerivationInput): MachineArtifactSet {
  if (!plainRecord(input) || !exact(input, ["schema_version", "profile", "phase_set", "capabilities",
    "worktree_policy", "human_input", "human"]) || input.schema_version !== 2 ||
    input.human_input.schema_version !== 2 ||
    !planProfileSchema.safeParse(input.profile).success || !plannedPhaseSetSchema.safeParse(input.phase_set).success ||
    input.phase_set.profile_classification_hash !== input.profile.classification_hash ||
    !stringArray(input.capabilities, 0, capabilities.length, 32) ||
    input.capabilities.some((capability) => !capabilities.includes(capability)) ||
    !["project_default", "required", "forbidden"].includes(input.worktree_policy) ||
    !validHumanSet(input.human)) {
    return fail("PLAN_ARTIFACT_INPUT_INVALID");
  }
  const expectedHuman = buildHumanArtifactsCanonical(input.human_input);
  if (!same(expectedHuman, input.human) || !same(input.profile, input.human_input.profile) ||
    !same(input.phase_set, input.human_input.phase_set)) return fail("PLAN_ARTIFACT_INPUT_INVALID");
  const human = expectedHuman;
  const caps = sortedUnique(input.capabilities);
  const gate_policy = machineArtifact("gate_policy", human, {
    mode: input.profile.mode, capabilities: caps, planned_phases: input.phase_set.planned_phases,
    required_validations: input.profile.required_validations
  }, {
    capabilities: stableHash(caps), plan_profile: stableHash(input.profile),
    planned_phase_set: stableHash(input.phase_set)
  });
  const worktree = machineArtifact("worktree", human,
    { policy: input.worktree_policy, requested: input.worktree_policy === "required" },
    { worktree_policy: stableHash(input.worktree_policy) });
  const implementation_checkpoints = machineArtifact("implementation_checkpoints", human,
    { tasks: human.plan.content.tasks.map((task) => ({ task_id: task.task_id,
      objective: task.objective, affected_paths: task.affected_paths, depends_on: task.depends_on,
      owner_phase: task.owner_phase, decision_refs: task.decision_refs,
      scenario_refs: task.scenario_refs, requirement_refs: task.requirement_refs,
      evidence_refs: task.evidence_refs, ownership_refs: task.ownership_refs })), foundation_gate: "approved" });
  // 白名单式投影：新增的场景字段不写进这里就到不了 meta/scenario-manifest.json，
  // run/test 门禁也就消费不了它。priority/owner_phase/required_evidence_kind 与
  // 可执行三元正是门禁判定 "哪些场景必须带 ledger 证据、在哪个阶段到期" 的依据。
  const scenario_manifest = machineArtifact("scenario_manifest", human,
    { scenarios: human.test_scenarios.content.scenarios.map((scenario) => ({
      scenario_id: scenario.scenario_id, coverage_dimension: scenario.coverage_dimension,
      execution_level: scenario.execution_level, evidence_requirements: scenario.evidence_requirements,
      risk_level: scenario.risk_level, priority: scenario.priority,
      owner_phase: scenario.owner_phase,
      required_evidence_kind: PRIORITY_EVIDENCE_KIND[scenario.priority] ?? "advisory",
      ...(scenario.executable_test_id === undefined
        ? {} : { executable_test_id: scenario.executable_test_id }),
      ...(scenario.test_file === undefined ? {} : { test_file: scenario.test_file }),
      ...(scenario.test_title === undefined ? {} : { test_title: scenario.test_title }),
      task_refs: scenario.task_refs,
      requirement_refs: scenario.requirement_refs
    })), coverage: human.test_scenarios.content.coverage });
  const body = { schema_version: 2 as const, gate_policy, worktree, implementation_checkpoints,
    scenario_manifest };
  const artifact_set_hash = stableHash(body);
  return deepFreeze({ ...body, artifact_set_hash,
    artifact_set_id: `plan_machine_artifact_set:${artifact_set_hash.slice("sha256:".length)}` });
}

function deriveImplementationDetailCanonical(input: Parameters<PlanArtifactModel["deriveImplementationDetail"]>[0]):
ImplementationDetailArtifact {
  if (!plainRecord(input) || !exact(input, ["mode", "human_input", "human"]) ||
    !["quick", "standard", "assurance"].includes(input.mode) ||
    !validHumanSet(input.human)) {
    return fail("PLAN_ARTIFACT_INPUT_INVALID");
  }
  const expectedHuman = buildHumanArtifactsCanonical(input.human_input);
  if (!same(expectedHuman, input.human) || input.mode !== input.human_input.profile.mode) {
    return fail("PLAN_ARTIFACT_INPUT_INVALID");
  }
  const human = expectedHuman;
  const tasks = human.plan.content.tasks;
  const scenarios = human.test_scenarios.content.scenarios;
  const base: Record<string, unknown> = {
    key_modifications: tasks.map((task) => ({ task_id: task.task_id, objective: task.objective,
      affected_paths: task.affected_paths })),
    commands: sortedUnique(scenarios.flatMap((scenario) => scenario.verification_command === undefined ? [] :
      [scenario.verification_command])),
    boundaries: [...human.design.content.compatibility_boundaries,
      ...human.design.content.failure_behaviors]
  };
  if (input.mode !== "quick") Object.assign(base, {
    interfaces: [human.design.content.behavior_contract],
    data_constraints: human.design.content.constraints,
    module_order: tasks.map((task) => task.task_id),
    test_strategy: scenarios.map((scenario) => ({ scenario_id: scenario.scenario_id,
      execution_level: scenario.execution_level }))
  });
  if (input.mode === "assurance") Object.assign(base, {
    migration: scenarios.filter((scenario) => scenario.coverage_dimension === "data_compatibility")
      .map((scenario) => scenario.scenario_id),
    failure_recovery: human.design.content.failure_behaviors,
    concurrency: scenarios.filter((scenario) => scenario.coverage_dimension === "concurrency_idempotency")
      .map((scenario) => scenario.scenario_id),
    permissions: scenarios.filter((scenario) => scenario.coverage_dimension === "permission_boundaries")
      .map((scenario) => scenario.scenario_id),
    rollback: human.design.content.compatibility_boundaries
  });
  return deepFreeze({ ...artifact("implementation_detail", {
    design: human.design.content_hash, plan: human.plan.content_hash,
    test_scenarios: human.test_scenarios.content_hash, derivation_mode: stableHash(input.mode)
  }, base), mode: input.mode }) as ImplementationDetailArtifact;
}

function same(left: unknown, right: unknown): boolean { return stableHash(left) === stableHash(right); }

export function createPlanArtifactModel(): PlanArtifactModel {
  return deepFreeze({
    buildHumanArtifacts(input) { return buildHumanArtifactsCanonical(snap<HumanArtifactBuildInput>(input)); },
    deriveMachineArtifacts(input) {
      return deriveMachineArtifactsCanonical(snap<MachineArtifactDerivationInput>(input));
    },
    deriveImplementationDetail(input) {
      return deriveImplementationDetailCanonical(snap<Parameters<PlanArtifactModel["deriveImplementationDetail"]>[0]>(input));
    },
    verifyArtifactSet(input): ArtifactSetVerification {
      try {
        const value = snapshotData(input) as typeof input;
        if (!plainRecord(value) || !exact(value, ["human_input", "human", "machine_input", "machine", "detail"])) {
          return deepFreeze({ valid: false, reason_code: "PLAN_ARTIFACT_SET_INVALID" });
        }
        const expectedHuman = buildHumanArtifactsCanonical(value.human_input);
        if (!same(expectedHuman, value.human)) return deepFreeze({ valid: false,
          reason_code: "PLAN_ARTIFACT_SOURCE_DRIFT" });
        const expectedMachine = deriveMachineArtifactsCanonical({ ...value.machine_input,
          human_input: value.human_input, human: expectedHuman });
        const expectedDetail = deriveImplementationDetailCanonical({ mode: value.human_input.profile.mode,
          human_input: value.human_input, human: expectedHuman });
        if (!same(expectedMachine, value.machine) || !same(expectedDetail, value.detail)) return deepFreeze({ valid: false,
          reason_code: "PLAN_ARTIFACT_SET_INVALID" });
        const ids = [expectedHuman.design.artifact_id, expectedHuman.plan.artifact_id,
          expectedHuman.test_scenarios.artifact_id, expectedMachine.gate_policy.artifact_id,
          expectedMachine.worktree.artifact_id, expectedMachine.implementation_checkpoints.artifact_id,
          expectedMachine.scenario_manifest.artifact_id, expectedDetail.artifact_id];
        return deepFreeze(new Set(ids).size === ids.length ? { valid: true, reason_code: "PLAN_ARTIFACT_SET_VALID" } :
          { valid: false, reason_code: "PLAN_ARTIFACT_SET_INVALID" });
      } catch {
        return deepFreeze({ valid: false, reason_code: "PLAN_ARTIFACT_SET_INVALID" });
      }
    },
    normalizeLegacy(input, trusted) {
      try {
        const value = snapshotData(input);
        if (!plainRecord(value)) return deepFreeze({ ok: false, reason_code: "PLAN_ARTIFACT_RECORD_INVALID" });
        if (value.schema_version === 2) {
          if (trusted === undefined) return deepFreeze({ ok: false, reason_code: "PLAN_ARTIFACT_RECORD_INVALID" });
          const expected = buildHumanArtifactsCanonical(snap<HumanArtifactBuildInput>(trusted));
          return same(expected, value) ? deepFreeze({ ok: true,
            source_schema_version: 2, readiness: "current",
            artifacts: expected }) : deepFreeze({ ok: false, reason_code: "PLAN_ARTIFACT_RECORD_INVALID" });
        }
        if (value.schema_version === 1 && validLegacyV1HumanSet(value)) return deepFreeze({ ok: true,
          source_schema_version: 1, readiness: "legacy_read_only", legacy: value });
        if (value.schemaVersion === 0 && exact(value, ["schemaVersion", "changeName", "frontmatterStatus",
          "standardInputs"]) && bounded(value.changeName, 160) && value.frontmatterStatus === "approved" &&
          stringArray(value.standardInputs, 6, 6, 256) && value.standardInputs.every(canonicalPath) &&
          same(value.standardInputs, ["design.md", "plan.md",
            "implementation-detail.md", "test-scenarios.md", "gate-policy.json", "worktree.json"])) {
          return deepFreeze({ ok: true, source_schema_version: 0,
          readiness: "legacy_read_only", legacy: { change_name: value.changeName,
            frontmatter_status: value.frontmatterStatus, standard_inputs: value.standardInputs } });
        }
        const version = value.schema_version ?? value.schemaVersion;
        return deepFreeze({ ok: false, reason_code: version === undefined || version === 0 || version === 1 || version === 2 ?
          "PLAN_ARTIFACT_RECORD_INVALID" : "PLAN_ARTIFACT_VERSION_UNSUPPORTED" });
      } catch { return deepFreeze({ ok: false, reason_code: "PLAN_ARTIFACT_RECORD_INVALID" }); }
    }
  });
}
