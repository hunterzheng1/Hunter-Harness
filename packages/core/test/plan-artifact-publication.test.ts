import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { PLAN_PHASES, classifyPlan, configurePlannedPhases } from "../src/plan-classification/index.js";
import { createPlanDecisionModule } from "../src/plan-decision/index.js";
import {
  createPlanArtifactModel,
  planArtifactPublication,
  type CoverageApplicabilityInput,
  type HumanArtifactBuildInput,
  type TestScenarioInput
} from "../src/plan-artifacts/index.js";
import { createPlanningContextModule } from "../src/planning-context/index.js";

const now = "2026-08-13T10:00:00.000Z";
const sha = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as const;
const dimensions = ["business_rules", "concurrency_idempotency", "data_compatibility", "error_codes",
  "integration_impact", "normal_path", "parameter_validation", "permission_boundaries"] as const;

function stableHash(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) :
    input !== null && typeof input === "object" ? Object.fromEntries(Object.entries(input)
      .filter(([, child]) => child !== undefined).sort(([left], [right]) => left < right ? -1 : 1)
      .map(([key, child]) => [key, canonical(child)])) : input;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function scenario(id: string, dimension: TestScenarioInput["coverage_dimension"]): TestScenarioInput {
  return { scenario_id: id, title: `验证 ${dimension}`, acceptance: `${dimension} 行为符合批准设计`,
    coverage_dimension: dimension, execution_level: dimension === "integration_impact" ? "integration" : "unit",
    evidence_requirements: ["focused_test"], verification_command: `npm test -- ${id}`, risk_level: "medium",
    task_refs: ["task:module"], requirement_refs: [] };
}

function trustedInput(): HumanArtifactBuildInput {
  const profile = classifyPlan({ schema_version: 1, change_id: "change-11-publication",
    risk_signals: ["production_code", "cross_file"], created_at: now });
  const phase_set = configurePlannedPhases(profile, { schema_version: 1, is_git: true, has_remote: true,
    uses_worktree: false, available_phases: PLAN_PHASES, requested_optional_phases: [], requested_omissions: [],
    configured_at: now });
  const planning = createPlanningContextModule();
  const intent = planning.buildIntent({ schema_version: 1, source_input: "发布规划产物", goal: "稳定发布规划产物",
    user_visible_outcome: "人类文档可读且机器派生物精确", in_scope: ["plan_artifacts"], out_of_scope: ["knowledge"],
    constraints: ["legacy_read_only"], acceptance_examples: ["八文件精确", "路径越权拒绝"], uncertainties: [], created_at: now });
  const evidence = planning.buildEvidenceMap({ schema_version: 1, map_manifest_hash: sha("a"), sources: [{
    source_kind: "map", source_id: "map:publication", source_version: "v1", content_hash: sha("b"),
    module_refs: ["plan_artifacts"], symbol_refs: ["planArtifactPublication"], consumer_refs: ["finalizer"],
    test_refs: ["plan-artifact-publication.test.ts"], constraint_refs: ["legacy_read_only"], unknown_refs: []
  }], budget: { max_sources: 2, max_refs: 16 }, created_at: now });
  const context = planning.buildPlanningContext({ profile, phase_set, intent, evidence,
    map_manifest_hash: sha("a"), created_at: now });
  const decision = createPlanDecisionModule();
  const graph = decision.evaluateDecisionGraph({ schema_version: 1, profile, phase_set, context, intent, evidence,
    nodes: [], evaluated_at: now });
  const content = { goal: "稳定发布规划产物", user_visible_outcome: "人类文档可读且机器派生物精确",
    in_scope: ["plan_artifacts"], out_of_scope: ["knowledge"], recommended_design: "三份[人类]*真相源*机械渲染",
    key_alternatives: ["raw JSON markdown"], invariants: ["机器产物不得成为知识"],
    failure_behaviors: ["路径未授权时拒绝"], compatibility_boundaries: ["legacy read-only"],
    risks: [{ risk: "漂移", mitigation: "绑定哈希" }],
    acceptance_examples: ["八文件精确", "路径越权拒绝", "旧版本只读"] };
  const approval_package_input = { content, created_at: now };
  const approval_package = decision.buildApprovalPackage({ schema_version: 1, profile, phase_set, context, intent,
    evidence, graph, ...approval_package_input });
  const approval_receipt = decision.recordApproval({ package: approval_package, graph, profile, phase_set, context,
    intent, evidence, package_input: approval_package_input, outcome: "approved", approver_id: "user:owner",
    decided_at: now }).receipt;
  const scopeText = "plan_artifacts";
  const scope_ref = `scope:${stableHash({ text: scopeText }).slice(7)}`;
  const evidenceRefs = ["module:plan_artifacts", "symbol:planArtifactPublication"];
  const requirements = [{ kind: "behavior" as const, text: content.recommended_design },
    { kind: "invariant" as const, text: content.invariants[0] as string },
    { kind: "failure_behavior" as const, text: content.failure_behaviors[0] as string }]
    .map((item) => { const body = { ...item, evidence_refs: evidenceRefs, approved_scope_refs: [scope_ref] };
      return { requirement_id: `requirement:${stableHash(body).slice(7)}`, ...body }; });
  const requirementRefs = requirements.map((item) => item.requirement_id);
  const scenarios = [scenario("scenario:normal", "normal_path"), scenario("scenario:parameter", "parameter_validation"),
    scenario("scenario:integration", "integration_impact")].map((item) => ({ ...item,
      requirement_refs: requirementRefs }));
  const coverage: CoverageApplicabilityInput[] = dimensions.map((coverage_dimension) => {
    const refs = scenarios.filter((item) => item.coverage_dimension === coverage_dimension)
      .map((item) => item.scenario_id);
    return refs.length === 0 ? { coverage_dimension, applicability: "not_applicable", scenario_refs: [],
      not_applicable_reason: `不涉及 ${coverage_dimension}` } :
      { coverage_dimension, applicability: "applicable", scenario_refs: refs };
  });
  const ownershipBody = { path: "packages/core/src/plan-artifacts/publication/module.ts",
    approved_scope_refs: [scope_ref], evidence_refs: evidenceRefs };
  const ownership = { ownership_ref: `ownership:${stableHash(ownershipBody).slice(7)}`, ...ownershipBody };
  return { schema_version: 2, profile, phase_set, context, intent, evidence, graph, approval_package,
    approval_package_input, approval_receipt, structured_input: { change_key: "change-11-publication",
      requirements, approved_scopes: [{ scope_ref, text: scopeText }], ownership: [ownership], tasks: [{
        task_id: "task:module", objective: "实现发布payload契约",
        affected_paths: [ownership.path], depends_on: [], owner_phase: "run", decision_refs: [],
        scenario_refs: scenarios.map((item) => item.scenario_id), requirement_refs: requirementRefs,
        evidence_refs: evidenceRefs, ownership_refs: [ownership.ownership_ref]
      }], scenarios, coverage } };
}

function trusted() {
  const input = trustedInput(); const model = createPlanArtifactModel();
  const human = model.buildHumanArtifacts(input);
  const machine_input = { schema_version: 2 as const, profile: input.profile, phase_set: input.phase_set,
    capabilities: ["filesystem"] as const, worktree_policy: "project_default" as const };
  const machine = model.deriveMachineArtifacts({ ...machine_input, human_input: input, human });
  const detail = model.deriveImplementationDetail({ mode: input.profile.mode, human_input: input, human });
  return { human_input: input, human, machine_input, machine, detail };
}

function legacyV1(value: ReturnType<typeof trusted>) {
  const without = (record: object, keys: readonly string[]) => Object.fromEntries(Object.entries(record)
    .filter(([key]) => !keys.includes(key)));
  const artifact = (artifact_type: "design" | "plan" | "test_scenarios", content: unknown) => {
    const content_hash = stableHash({ artifact_type, content });
    return { schema_version: 1, artifact_type, source_hashes: value.human.design.source_hashes,
      generator_version: "hunter-harness-plan-artifacts/1", content_hash,
      artifact_id: `plan_artifact:${artifact_type}:${content_hash.slice(7)}`, content };
  };
  const body = { schema_version: 1,
    design: artifact("design", without(value.human.design.content, ["requirements", "approved_scopes", "ownership"])),
    plan: artifact("plan", { change_key: value.human.plan.content.change_key,
      tasks: value.human.plan.content.tasks.map((item) => without(item,
        ["requirement_refs", "evidence_refs", "ownership_refs"])) }),
    test_scenarios: artifact("test_scenarios", {
      scenarios: value.human.test_scenarios.content.scenarios.map((item) => without(item,
        ["task_refs", "requirement_refs"])), coverage: value.human.test_scenarios.content.coverage }) };
  const artifact_set_hash = stableHash(body);
  return { ...body, artifact_set_hash,
    artifact_set_id: `plan_artifact_set:${artifact_set_hash.slice(7)}` };
}

const authority = { verify: () => true };

describe("Stage11-M4A artifact publication payload contract", () => {
  it("renders exact eight canonical payloads without turning human truth into raw JSON", async () => {
    const expected = JSON.parse(await readFile(new URL(
      "./fixtures/plan-artifact-publication-v1-current.json", import.meta.url), "utf8"));
    const result = planArtifactPublication({ schema_version: 1, change_key: "change-11-publication",
      trusted: trusted() }, authority);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.payloads.map((item) => item.path)).toEqual(expected.paths);
    expect(result.plan.payloads.map((item) => item.classification)).toEqual(expected.classifications);
    expect(result.plan.payloads[0]?.serialized_content).toContain("# Design\n\n## Goal");
    expect(result.plan.payloads[0]?.serialized_content).not.toContain('"goal":');
    expect(result.plan.payloads[0]?.serialized_content).toContain("三份\\[人类\\]\\*真相源\\*机械渲染");
    expect(result.plan.payloads[1]?.serialized_content).toContain("## Tasks");
    expect(result.plan.payloads[2]?.serialized_content).toContain("## Coverage");
    for (const item of result.plan.payloads) {
      expect(item.byte_length).toBe(Buffer.byteLength(item.serialized_content));
      expect(item.bytes).toEqual([...Buffer.from(item.serialized_content)]);
      expect(item.serialized_sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(item).not.toHaveProperty("knowledge");
      expect(Object.isFrozen(item)).toBe(true);
      expect(Object.isFrozen(item.bytes)).toBe(true);
    }
    expect(result.plan.publication_intent_id).toBe(`plan_publication:${result.plan.manifest_hash.slice(7)}`);
    expect(result.plan.manifest.entries.map((item) => item.path)).toEqual(expected.paths);
    expect(result.plan.manifest.entries[0]).not.toHaveProperty("serialized_content");
    expect(result.plan.manifest.entries[0]).not.toHaveProperty("bytes");
    expect(Object.isFrozen(result.plan.manifest)).toBe(true);
    expect(Object.isFrozen(result.plan)).toBe(true);
  });

  it("projects every requirement and ownership derivation reference into stable Markdown", () => {
    const value = trusted();
    const result = planArtifactPublication({ schema_version: 1, change_key: "change-11-publication",
      trusted: value }, authority);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const design = result.plan.payloads[0]?.serialized_content ?? "";
    expect(design).toContain(`content_hash: ${value.human.design.content_hash}`);
    const requirementSection = design.split("## Requirements\n\n")[1]?.split("\n\n## Approved scopes")[0] ?? "";
    for (const requirement of value.human.design.content.requirements) {
      const block = requirementSection.split(`- ${requirement.requirement_id} `)[1]?.split("\n- requirement:")[0] ?? "";
      expect(block).toContain(`  - Evidence refs: ${[...requirement.evidence_refs].sort().join(", ")}`);
      expect(block).toContain(`  - Approved scope refs: ${[...requirement.approved_scope_refs].sort().join(", ")}`);
    }
    const ownershipSection = design.split("## Ownership\n\n")[1] ?? "";
    for (const ownership of value.human.design.content.ownership) {
      const block = ownershipSection.split(`- ${ownership.ownership_ref}: `)[1]?.split("\n- ownership:")[0] ?? "";
      expect(block).toContain(`  - Evidence refs: ${[...ownership.evidence_refs].sort().join(", ")}`);
      expect(block).toContain(`  - Approved scope refs: ${[...ownership.approved_scope_refs].sort().join(", ")}`);
    }
    const tampered = structuredClone(value);
    tampered.human.design.content.requirements[0]?.evidence_refs.splice(0, 1, "symbol:foreign");
    expect(planArtifactPublication({ schema_version: 1, change_key: "change-11-publication",
      trusted: tampered }, authority)).toEqual({ ok: false,
        reason_code: "PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID" });
  });

  it("binds the trusted change key and exact path authority before producing payloads", () => {
    const seen: unknown[] = [];
    const result = planArtifactPublication({ schema_version: 1, change_key: "change-11-publication",
      trusted: trusted() }, { verify(value) { seen.push(value); return false; } });
    expect(result).toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_PUBLICATION_PATH_UNAUTHORIZED" });
    expect(seen).toEqual([expect.objectContaining({ change_key: "change-11-publication",
      paths: expect.arrayContaining(["meta/scenario-manifest.json"]) })]);
    expect(planArtifactPublication({ schema_version: 1, change_key: "change-11-foreign", trusted: trusted() }, authority))
      .toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID" });
    expect(planArtifactPublication({ schema_version: 1, change_key: "change:11", trusted: trusted() }, authority))
      .toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID" });
  });

  it("is deterministic and binds serialized bytes separately from semantic artifact identity", () => {
    const value = trusted();
    const first = planArtifactPublication({ schema_version: 1, change_key: "change-11-publication",
      trusted: value }, authority);
    const second = planArtifactPublication({ schema_version: 1, change_key: "change-11-publication",
      trusted: value }, authority);
    expect(second).toEqual(first);
    if (!first.ok) return;
    for (const item of first.plan.payloads) {
      expect(item.serialized_sha256).toBe(`sha256:${createHash("sha256")
        .update(Buffer.from(item.bytes)).digest("hex")}`);
    }
    expect(first.plan.payloads[0]?.semantic_content_hash).toBe(value.human.design.content_hash);
    expect(first.plan.payloads[0]?.serialized_sha256).not.toBe(value.human.design.content_hash);
  });

  it("keeps v0 and v1 artifact records read-only and cannot plan publication", async () => {
    const v0 = JSON.parse(await readFile(new URL(
      "./fixtures/plan-artifact-publication-v0-legacy.json", import.meta.url), "utf8"));
    expect(planArtifactPublication(v0, authority))
      .toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_PUBLICATION_LEGACY_READ_ONLY" });
    const v1 = legacyV1(trusted());
    expect(planArtifactPublication({ schema_version: 1, change_key: "change-11-standard", trusted: v1 }, authority))
      .toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_PUBLICATION_LEGACY_READ_ONLY" });
  });

  it("rejects object accessors and Proxy records without executing hostile code", () => {
    let executions = 0;
    const accessor = Object.defineProperty({}, "schema_version", { enumerable: true,
      get() { executions += 1; return 1; } });
    const proxy = new Proxy({}, { get() { executions += 1; throw new Error("trap"); },
      ownKeys() { executions += 1; throw new Error("trap"); } });
    expect(planArtifactPublication(accessor, authority)).toEqual({ ok: false,
      reason_code: "PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID" });
    expect(planArtifactPublication(proxy, authority)).toEqual({ ok: false,
      reason_code: "PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID" });
    const nestedAccessor = { schema_version: 1, change_key: "change-11-publication",
      trusted: Object.defineProperty({}, "human", { enumerable: true,
        get() { executions += 1; throw new Error("nested getter"); } }) };
    const nestedProxy = { schema_version: 1, change_key: "change-11-publication", trusted: proxy };
    expect(planArtifactPublication(nestedAccessor, authority)).toEqual({ ok: false,
      reason_code: "PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID" });
    expect(planArtifactPublication(nestedProxy, authority)).toEqual({ ok: false,
      reason_code: "PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID" });
    expect(executions).toBe(0);
  });

  it("accepts only an exact synchronous data-descriptor path authority without invoking hostile traps", () => {
    const value = { schema_version: 1, change_key: "change-11-publication", trusted: trusted() };
    let executions = 0;
    const accessor = Object.defineProperty({}, "verify", { enumerable: true,
      get() { executions += 1; return () => true; } });
    const proxy = new Proxy({}, { get() { executions += 1; return () => true; },
      ownKeys() { executions += 1; return ["verify"]; } });
    const callableProxy = new Proxy(() => true, { apply() { executions += 1; return true; } });
    for (const candidate of [accessor, proxy, { verify: callableProxy }, { verify: () => Promise.resolve(true) },
      { verify: () => true, extra: true }]) {
      expect(planArtifactPublication(value, candidate as never)).toEqual({ ok: false,
        reason_code: "PLAN_ARTIFACT_PUBLICATION_PATH_UNAUTHORIZED" });
    }
    expect(executions).toBe(0);
  });

  it("fails closed when repeated bounded strings exceed the aggregate input budget", () => {
    let authorityCalls = 0;
    let getterCalls = 0;
    const repeated = "x".repeat(100_000);
    const hostileTail = Object.defineProperty({ repeated: Array.from({ length: 90 }, () => repeated) },
      "tail", { enumerable: true, get() { getterCalls += 1; return "unreachable"; } });
    const oversized = { schema_version: 1, change_key: "change-11-publication", trusted: hostileTail };
    expect(planArtifactPublication(oversized, { verify() { authorityCalls += 1; return true; } }))
      .toEqual({ ok: false, reason_code: "PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID" });
    expect(authorityCalls).toBe(0);
    expect(getterCalls).toBe(0);
  });
});
