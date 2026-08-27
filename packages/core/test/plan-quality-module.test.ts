import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { PLAN_PHASES, classifyPlan, configurePlannedPhases } from "../src/plan-classification/index.js";
import { createPlanningContextModule } from "../src/planning-context/index.js";
import { createPlanDecisionModule, type ApprovalContentInput } from "../src/plan-decision/index.js";
import { createPlanArtifactModel, type HumanArtifactBuildInput } from "../src/plan-artifacts/index.js";
import { createPlanQualityModule, type PlanEvent, type TrustedArtifactSetInput } from "../src/plan-quality/index.js";

const now = "2026-08-13T10:00:00.000Z";
const sha = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as const;
const dimensions = ["business_rules", "concurrency_idempotency", "data_compatibility", "error_codes",
  "integration_impact", "normal_path", "parameter_validation", "permission_boundaries"] as const;
function testHash(value: unknown): `sha256:${string}` {
  function canonical(input: unknown): unknown { if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") return Object.fromEntries(Object.entries(input)
      .filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)])); return input; }
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function planEvent(input: Partial<PlanEvent> = {}): PlanEvent {
  const body = {
    lifecycle_kind: "change" as const,
    run_id: "run:quality",
    change_key: "change:quality",
    phase: "plan" as const,
    attempt: 1,
    type: "phase_started" as const,
    producer_seq: 1,
    occurred_at: now,
    ...input
  };
  const machine = { lifecycle_kind: body.lifecycle_kind, run_id: body.run_id, change_key: body.change_key,
    phase: body.phase, attempt: body.attempt, type: body.type, producer_seq: body.producer_seq };
  return { schema_version: 1, ...body,
    event_id: `plan_event:${testHash({ ...machine, occurred_at: body.occurred_at }).slice(7)}`,
    idempotency_key: testHash(machine) };
}

function serializedEventBundle(events: readonly PlanEvent[]): string {
  const body = { schema_version: 1 as const, lifecycle_kind: "change" as const,
    run_id: events[0]?.run_id ?? "run:quality", change_key: events[0]?.change_key ?? "change:quality", events };
  return JSON.stringify({ ...body, bundle_hash: testHash(body) });
}

function rehashEventBundle(serialized: string, mutate: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(serialized) as Record<string, unknown>; mutate(value);
  const { bundle_hash: _ignored, ...body } = value; void _ignored;
  return JSON.stringify({ ...body, bundle_hash: testHash(body) });
}

function approvalContent(): ApprovalContentInput {
  return { goal: "冻结质量门", user_visible_outcome: "仅完整验证的规划可发布", in_scope: ["plan_quality"],
    out_of_scope: ["python_finalizer"], recommended_design: "三层收据驱动唯一发布意图",
    key_alternatives: ["继续依赖叙述式自检"], invariants: ["结构失败绝不发布"],
    failure_behaviors: ["结构失败绝不发布"], compatibility_boundaries: ["旧质量记录只读"],
    risks: [{ risk: "评审循环", mitigation: "委派失败最多一次 inline fallback" }],
    acceptance_examples: ["quick只执行结构层", "standard执行语义层", "assurance完成对抗层"] };
}

function humanInput(mode: "quick" | "standard" | "assurance", rejectedReuse = false): HumanArtifactBuildInput {
  const signals = mode === "quick" ? ["narrow_fix"] as const : mode === "standard" ?
    ["production_code", "cross_file"] as const : ["security", "migration"] as const;
  const profile = classifyPlan({ schema_version: 1, change_id: `quality-${mode}`, risk_signals: signals, created_at: now });
  const phase_set = configurePlannedPhases(profile, { schema_version: 1, is_git: true, has_remote: true,
    uses_worktree: false, available_phases: PLAN_PHASES, requested_optional_phases: [], requested_omissions: [],
    configured_at: now });
  const planning = createPlanningContextModule();
  const intent = planning.buildIntent({ schema_version: 1, source_input: "建立Plan质量门", goal: "冻结质量门",
    user_visible_outcome: "仅完整验证的规划可发布", in_scope: ["plan_quality"], out_of_scope: ["python_finalizer"],
    constraints: ["no_fs_write"], acceptance_examples: ["结构失败阻塞", "重试事件不覆盖"], uncertainties: [],
    created_at: now });
  const evidence = planning.buildEvidenceMap({ schema_version: 1, map_manifest_hash: sha("a"), sources: [{
    source_kind: "map", source_id: "map:quality", source_version: "v1", content_hash: sha("b"),
    module_refs: ["plan_quality"], symbol_refs: ["PlanQualityModule"], consumer_refs: ["finalizer"],
    test_refs: ["plan-quality-module.test.ts"], constraint_refs: ["no_fs_write"], unknown_refs: []
  }], budget: { max_sources: 2, max_refs: 16 }, created_at: now });
  const context = planning.buildPlanningContext({ profile, phase_set, intent, evidence,
    map_manifest_hash: sha("a"), created_at: now });
  const decision = createPlanDecisionModule();
  const rejectedDecision = { schema_version: 1 as const, decision_id: "decision:rejected", decision_version: 1,
    type: "product_decision" as const, depends_on: [], status: "resolved" as const,
    question: "是否继续使用已拒方案", recommendation: "拒绝", recommendation_reason: "超出批准边界",
    tradeoffs: ["兼容成本"], affected_behaviors: ["quality_gate"], evidence_refs: [], resolution: "rejected",
    resolved_by: "user" as const, resolved_at: now };
  const graph = decision.evaluateDecisionGraph({ schema_version: 1, profile, phase_set, context, intent, evidence,
    nodes: rejectedReuse ? [rejectedDecision] : [], evaluated_at: now });
  const approval_package_input = { content: approvalContent(), created_at: now };
  const approval_package = decision.buildApprovalPackage({ schema_version: 1, profile, phase_set, context, intent,
    evidence, graph, ...approval_package_input });
  const approval_receipt = decision.recordApproval({ package: approval_package, graph, profile, phase_set, context,
    intent, evidence, package_input: approval_package_input, outcome: "approved", approver_id: "user:owner",
    decided_at: now }).receipt;
  const scopeText = "plan_quality";
  const scope_ref = `scope:${testHash({ text: scopeText }).slice(7)}`;
  const evidence_refs = ["module:plan_quality", "symbol:PlanQualityModule"];
  const requirementSource = [{ kind: "behavior" as const, text: approvalContent().recommended_design },
    ...approvalContent().invariants.map((text) => ({ kind: "invariant" as const, text })),
    ...approvalContent().failure_behaviors.map((text) => ({ kind: "failure_behavior" as const, text }))];
  const requirements = requirementSource.map((item) => { const body = { ...item, evidence_refs,
    approved_scope_refs: [scope_ref] }; return { requirement_id: `requirement:${testHash(body).slice(7)}`, ...body }; });
  const requirement_refs = requirements.map((item) => item.requirement_id);
  const task_refs = ["task:quality"];
  const executable = (id: string) => ({
    priority: "P1" as const, owner_phase: "execute" as const,
    executable_test_id: `unit::${id}`, test_file: "tests/unit.spec.ts", test_title: id
  });
  const scenarios = [{ scenario_id: "scenario:normal", title: "正常发布", acceptance: "完整验证后发布",
    coverage_dimension: "normal_path" as const, execution_level: "unit" as const,
    evidence_requirements: ["focused_test"], risk_level: "medium" as const,
    ...executable("scenario:normal"), task_refs, requirement_refs },
  { scenario_id: "scenario:failure", title: "失败阻塞", acceptance: "结构失败不发布",
    coverage_dimension: "error_codes" as const, execution_level: "unit" as const,
    evidence_requirements: ["focused_test"], risk_level: mode === "assurance" ? "high" as const : "medium" as const,
    ...executable("scenario:failure"), task_refs, requirement_refs },
  { scenario_id: "scenario:integration", title: "集成发布", acceptance: "发布证据闭合",
    coverage_dimension: "integration_impact" as const, execution_level: "integration" as const,
    evidence_requirements: ["affected_test"], risk_level: mode === "assurance" ? "high" as const : "medium" as const,
    ...executable("scenario:integration"), task_refs, requirement_refs }];
  const coverage = dimensions.map((coverage_dimension) => {
    const refs = scenarios.filter((item) => item.coverage_dimension === coverage_dimension).map((item) => item.scenario_id);
    return refs.length > 0 ? { coverage_dimension, applicability: "applicable" as const, scenario_refs: refs } :
      { coverage_dimension, applicability: "not_applicable" as const, scenario_refs: [],
        not_applicable_reason: `当前变更不涉及 ${coverage_dimension}` };
  });
  const ownershipBody = { path: "packages/core/src/plan-quality/module.ts", approved_scope_refs: [scope_ref],
    evidence_refs };
  const ownership = { ownership_ref: `ownership:${testHash(ownershipBody).slice(7)}`, ...ownershipBody };
  return { schema_version: 2, profile, phase_set, context, intent, evidence, graph, approval_package,
    approval_package_input, approval_receipt, structured_input: { change_key: `quality-${mode}`, tasks: [{
      task_id: "task:quality", objective: "实现分层质量门", affected_paths: ["packages/core/src/plan-quality/module.ts"],
      depends_on: [], owner_phase: "execute", decision_refs: rejectedReuse ? [rejectedDecision.decision_id] : [],
      scenario_refs: scenarios.map((item) => item.scenario_id),
      requirement_refs, evidence_refs, ownership_refs: [ownership.ownership_ref]
    }], scenarios, coverage, requirements, approved_scopes: [{ scope_ref, text: scopeText }], ownership: [ownership] } };
}

function trusted(mode: "quick" | "standard" | "assurance" = "standard", rejectedReuse = false): TrustedArtifactSetInput {
  const input = humanInput(mode, rejectedReuse); const model = createPlanArtifactModel();
  const human = model.buildHumanArtifacts(input);
  const machine_input = { schema_version: 2 as const, profile: input.profile, phase_set: input.phase_set,
    capabilities: mode === "assurance" ? ["migration", "security"] as const : ["api"] as const,
    worktree_policy: "project_default" as const };
  const machine = model.deriveMachineArtifacts({ ...machine_input, human_input: input, human });
  const detail = model.deriveImplementationDetail({ mode, human_input: input, human });
  return { human_input: input, human, machine_input, machine, detail };
}

function publication(value: TrustedArtifactSetInput) {
  const source = [["design.md", value.human.design], ["gate-policy.json", value.machine.gate_policy],
    ["implementation-checkpoints.json", value.machine.implementation_checkpoints],
    ["implementation-detail.md", value.detail], ["plan.md", value.human.plan],
    ["scenario-manifest.json", value.machine.scenario_manifest], ["test-scenarios.md", value.human.test_scenarios],
    ["worktree.json", value.machine.worktree]] as const;
  const files = source.map(([path, artifact]) => { const format = path.endsWith(".md") ? "markdown" as const :
    "json" as const; const body = JSON.stringify(artifact); const serialized_content = format === "markdown" ?
      `---\nschema_version: 2\nartifact_type: ${artifact.artifact_type}\ncontent_hash: ${artifact.content_hash}\n---\n${body}` : body;
    return { path, format, serialized_content, serialized_hash: testHash(serialized_content) }; });
  return { schema_version: 1 as const, stage_id: "stage:quality", publication_intent_id: "publication:quality", files,
    ownership_paths: ["packages/core/src/plan-quality/module.ts"],
    approval_receipt_ref: value.human_input.approval_receipt.receipt_id,
    artifact_derivation_receipt_refs: [value.human.artifact_set_hash, value.machine.artifact_set_hash,
      value.detail.content_hash] };
}

function stageVerifier(verified = true) {
  return { verify(input: { stage_id: string; input_hash: string; files_hash: string;
    expected_content_hashes: Readonly<Record<string, string>>; approval_receipt_ref: string;
    artifact_derivation_receipt_refs: readonly string[] }) {
    const body = { schema_version: 1 as const, stage_id: input.stage_id, input_hash: input.input_hash,
      files_hash: input.files_hash, content_hashes: input.expected_content_hashes,
      approval_receipt_ref: input.approval_receipt_ref,
      artifact_derivation_receipt_refs: input.artifact_derivation_receipt_refs,
      atomic_publish_receipt: verified ? testHash("atomic") : "invalid", readback_hash: input.files_hash,
      verified_at: now };
    return { ...body, evidence_hash: testHash(body) };
  } };
}

function qualityAnchors(layer1: { readonly stage_verification: unknown }, layer2: {
  readonly input_hash: string; readonly evaluator_invoked: boolean; readonly findings: readonly unknown[];
  readonly status: string; readonly completed_at: string }) {
  return { trusted_stage_verification: layer1.stage_verification,
    trusted_semantic_projection: { input_hash: layer2.input_hash, evaluator_invoked: layer2.evaluator_invoked,
      findings: layer2.findings, status: layer2.status, completed_at: layer2.completed_at } };
}

function rehashLayer3(value: Record<string, unknown>): Record<string, unknown> {
  const { receipt_hash: _receiptHash, receipt_id: _receiptId, ...body } = value;
  void _receiptHash; void _receiptId;
  const receipt_hash = testHash(body);
  return { ...body, receipt_hash, receipt_id: `plan_quality:layer3:${receipt_hash.slice(7)}` };
}

describe("PlanQualityGate layered execution", () => {
  it("runs deterministic publication and ownership checks for every profile", () => {
    const module = createPlanQualityModule(); const value = trusted("quick");
    expect(module.runDeterministicGates({ trusted: value, publication: publication(value),
      stage_verifier_port: stageVerifier(), completed_at: now }))
      .toMatchObject({ layer: "deterministic", status: "passed", findings: [], publication_intent_id: "publication:quality" });
    expect(() => module.runDeterministicGates({ trusted: value, publication: publication(value),
      stage_verifier_port: stageVerifier(false), completed_at: now })).toThrowError(expect.objectContaining({
      code: "PLAN_QUALITY_INPUT_INVALID"
      }));
  });

  it("flags placeholders in machine projections and accepts RFC3339 completed_at", () => {
    const module = createPlanQualityModule(); const value = trusted("quick"); const original = publication(value);
    const files = original.files.map((file) => file.path === "gate-policy.json" ? {
      ...file, serialized_content: `${file.serialized_content.slice(0, -1)},"placeholder":"TODO"}`,
      serialized_hash: testHash(`${file.serialized_content.slice(0, -1)},"placeholder":"TODO"}`)
    } : file);
    const result = module.runDeterministicGates({ trusted: value, publication: { ...original, files },
      stage_verifier_port: stageVerifier(), completed_at: "2026-08-13T18:00:00+08:00" });
    expect(result).toMatchObject({ completed_at: "2026-08-13T18:00:00+08:00", status: "failed",
      findings: expect.arrayContaining([expect.objectContaining({ finding_id: "deterministic.placeholder" })]) });
  });

  it("does not call a semantic evaluator for quick and keeps semantic findings separate for standard", () => {
    const module = createPlanQualityModule(); let calls = 0; const quick = trusted("quick");
    const evaluator = { evaluate() { calls += 1; return []; } };
    expect(module.runSemanticGates({ trusted: quick, evaluator_port: evaluator, completed_at: now }))
      .toMatchObject({ status: "skipped", evaluator_invoked: false });
    const standard = trusted("standard");
    expect(module.runSemanticGates({ trusted: standard, evaluator_port: { evaluate() { return [{
      finding_id: "semantic.unapproved_scope", category: "scope", severity: "blocking" as const,
      source_refs: ["plan.md"], message_zh: "计划引入了未批准模块", suggested_location: "plan.md" }]; } }, completed_at: now }))
      .toMatchObject({ status: "failed", findings: expect.arrayContaining([
        expect.objectContaining({ finding_id: "semantic.unapproved_scope" })]) });
    expect(calls).toBe(0);
  });

  it("runs built-in semantic checks without a port and gives the port the complete bounded projection", () => {
    const module = createPlanQualityModule(); const value = trusted("standard"); let seen: unknown;
    const builtin = module.runSemanticGates({ trusted: value, completed_at: now });
    expect(builtin).toMatchObject({ evaluator_invoked: false, status: "passed" });
    module.runSemanticGates({ trusted: value, evaluator_port: { evaluate(input) { seen = input; return []; } },
      completed_at: now });
    expect(seen).toMatchObject({ trusted: value, approved_decisions: expect.any(Array),
      rejected_alternatives: [], builtin_findings: [], input_hash: expect.stringMatching(/^sha256:/u) });
  });

  it("blocks explicit user-rejected decision reuse and cannot self-rehash the finding away", () => {
    const module = createPlanQualityModule(); const value = trusted("standard", true);
    const semantic = module.runSemanticGates({ trusted: value, completed_at: now });
    expect(semantic).toMatchObject({ status: "failed", findings: [expect.objectContaining({
      category: "rejected_alternative", severity: "blocking",
      source_refs: ["decision:rejected", "approval_package", "plan.md"]
    })] });
    const body = { ...semantic, findings: [] };
    const { receipt_hash: _hash, receipt_id: _id, ...withoutReceipt } = body; void _hash; void _id;
    const receipt_hash = testHash(withoutReceipt);
    const forged = { ...withoutReceipt, receipt_hash,
      receipt_id: `plan_quality:layer2:${receipt_hash.slice(7)}` };
    const pub = publication(value);
    const layer1 = module.runDeterministicGates({ trusted: value, publication: pub,
      stage_verifier_port: stageVerifier(), completed_at: now });
    const layer3 = module.runAdversarialGates({ trusted: value, semantic,
      explicit_adversarial: false, prefer_delegated: false, completed_at: now });
    expect(() => module.finalizeQuality({ trusted: value, layer1, layer2: forged, layer3,
      ...qualityAnchors(layer1, semantic),
      trusted_review_execution: layer3.review_execution, publication: pub,
      run_id: "run:quality", attempt: 1, phase: "plan", completed_at: now }))
      .toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
  });

  it("requires trusted stage verification and parses markdown frontmatter exactly", () => {
    const module = createPlanQualityModule(); const value = trusted(); const pub = publication(value);
    expect(() => module.runDeterministicGates({ trusted: value, publication: pub,
      completed_at: now } as never)).toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
    let probes = 0; const hostile = Object.defineProperty({}, "verify", { enumerable: true,
      get() { probes += 1; return () => undefined; } });
    expect(() => module.runDeterministicGates({ trusted: value, publication: pub,
      stage_verifier_port: hostile as never, completed_at: now })).toThrowError(expect.objectContaining({
        code: "PLAN_QUALITY_INPUT_INVALID"
      }));
    expect(probes).toBe(0);
    const files = pub.files.map((file) => file.format === "markdown" && file.path === "design.md" ? { ...file,
      serialized_content: file.serialized_content.replace("schema_version: 2", "schemaVersion: 2") } : file)
      .map((file) => ({ ...file, serialized_hash: testHash(file.serialized_content) }));
    expect(module.runDeterministicGates({ trusted: value, publication: { ...pub, files },
      stage_verifier_port: stageVerifier(), completed_at: now })).toMatchObject({ status: "failed",
        findings: expect.arrayContaining([expect.objectContaining({ finding_id: "deterministic.parse" })]) });
    expect(() => module.runDeterministicGates({ trusted: value,
      publication: { ...pub, approval_receipt_ref: "approval_receipt:foreign" },
      stage_verifier_port: stageVerifier(), completed_at: now })).toThrowError(expect.objectContaining({
        code: "PLAN_QUALITY_INPUT_INVALID"
      }));
    expect(() => module.runDeterministicGates({ trusted: value,
      publication: { ...pub, artifact_derivation_receipt_refs: [testHash("foreign"),
        ...pub.artifact_derivation_receipt_refs.slice(1)] }, stage_verifier_port: stageVerifier(),
      completed_at: now })).toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
    const selfRehashed = { verify(input: Parameters<ReturnType<typeof stageVerifier>["verify"]>[0]) {
      const valid = stageVerifier().verify(input); const body = { ...valid, readback_hash: testHash("foreign") };
      const { evidence_hash: _ignored, ...withoutHash } = body; void _ignored;
      return { ...withoutHash, evidence_hash: testHash(withoutHash) };
    } };
    expect(() => module.runDeterministicGates({ trusted: value, publication: pub,
      stage_verifier_port: selfRehashed, completed_at: now })).toThrowError(expect.objectContaining({
        code: "PLAN_QUALITY_INPUT_INVALID"
      }));
  });

  it("keeps the layer3 input_hash stable across wall-clock completed_at values", () => {
    const module = createPlanQualityModule(); const value = trusted("assurance");
    const semanticA = module.runSemanticGates({ trusted: value, completed_at: now });
    const semanticB = module.runSemanticGates({ trusted: value,
      completed_at: "2027-01-01T00:00:00.000Z" });
    expect(semanticA.input_hash).toBe(semanticB.input_hash);
    expect(semanticA.receipt_hash).not.toBe(semanticB.receipt_hash);
    const first = module.runAdversarialGates({ trusted: value, semantic: semanticA,
      explicit_adversarial: false, prefer_delegated: false, reviewer_port: { review: () =>
        ({ reviewer_identity: "main_session", findings: [] }) }, completed_at: now });
    const second = module.runAdversarialGates({ trusted: value, semantic: semanticB,
      explicit_adversarial: false, prefer_delegated: false, reviewer_port: { review: () =>
        ({ reviewer_identity: "main_session", findings: [] }) },
      completed_at: "2027-01-01T00:00:00.000Z" });
    expect(first.input_hash).toBe(second.input_hash);
    expect(first.review_execution.input_hash).toBe(second.review_execution.input_hash);
  });

  it("falls back inline exactly once after delegated review failure", () => {
    const module = createPlanQualityModule(); const value = trusted("assurance"); const calls: string[] = [];
    const semantic = module.runSemanticGates({ trusted: value, completed_at: now });
    const result = module.runAdversarialGates({ trusted: value, semantic,
      explicit_adversarial: false, prefer_delegated: true, reviewer_port: { review(input) {
        calls.push(input.mode); if (input.mode === "delegated") throw new Error("unavailable");
        return { reviewer_identity: "main_session", findings: [] };
      } }, completed_at: now });
    expect(calls).toEqual(["delegated", "inline"]);
    expect(result).toMatchObject({ status: "passed", review_execution: { review_mode: "inline",
      delegation_attempted: true, delegation_outcome: "failed", fallback_reason: "delegation_failed" } });
  });

  it("normalizes delegated unavailable results before a successful inline fallback", () => {
    const module = createPlanQualityModule(); const value = trusted("assurance"); const calls: string[] = [];
    const semantic = module.runSemanticGates({ trusted: value, completed_at: now });
    const result = module.runAdversarialGates({ trusted: value, semantic,
      explicit_adversarial: false, prefer_delegated: true, reviewer_port: { review(input) {
        calls.push(input.mode);
        return input.mode === "delegated" ? undefined : { reviewer_identity: "main_session", findings: [] };
      } }, completed_at: now });
    expect(calls).toEqual(["delegated", "inline"]);
    expect(result).toMatchObject({ status: "passed", review_execution: { review_mode: "inline",
      delegation_attempted: true, delegation_outcome: "failed", fallback_reason: "delegation_empty",
      reviewer_identity: "main_session" } });
  });

  it("rejects malformed reviewer findings returned by the delegated-to-inline fallback", () => {
    const module = createPlanQualityModule(); const value = trusted("assurance");
    const semantic = module.runSemanticGates({ trusted: value, completed_at: now });
    expect(() => module.runAdversarialGates({ trusted: value, semantic, explicit_adversarial: false,
      prefer_delegated: true, reviewer_port: { review(input) {
        if (input.mode === "delegated") throw new Error("delegation unavailable");
        return { reviewer_identity: "main_session", findings: {} } as never;
      } }, completed_at: now })).toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
  });

  it("blocks assurance when review is unavailable and rejects a required high-risk lens marked NA", () => {
    const module = createPlanQualityModule(); const value = trusted("assurance");
    const semantic = module.runSemanticGates({ trusted: value, completed_at: now });
    expect(module.runAdversarialGates({ trusted: value, semantic,
      explicit_adversarial: false, prefer_delegated: false,
      completed_at: now })).toMatchObject({ status: "blocked" });
    expect(module.runAdversarialGates({ trusted: value, semantic, explicit_adversarial: false,
      prefer_delegated: false, completed_at: now }).lenses).toEqual(expect.arrayContaining([
      expect.objectContaining({ lens: "migration_rollback", applicability: "applicable" }),
      expect.objectContaining({ lens: "security_audit", applicability: "applicable" })]));
  });

  it("marks delegated review unavailable when no port exists and does not claim a succeeded reviewer", () => {
    const module = createPlanQualityModule(); const value = trusted("assurance");
    const semantic = module.runSemanticGates({ trusted: value, completed_at: now });
    expect(module.runAdversarialGates({ trusted: value, semantic, explicit_adversarial: false,
      prefer_delegated: true, completed_at: now })).toMatchObject({ status: "blocked", review_execution: {
      review_mode: "inline", delegation_attempted: true, delegation_outcome: "unavailable",
      fallback_reason: "delegation_unavailable", reviewer_identity: "review_unavailable"
    } });
  });

  it("uses explicit high-risk findings to trigger review without changing the profile", () => {
    const module = createPlanQualityModule(); const value = trusted("quick"); let calls = 0;
    const semantic = module.runSemanticGates({ trusted: value, completed_at: now });
    const result = module.runAdversarialGates({ trusted: value, semantic,
      explicit_adversarial: true, prefer_delegated: false, reviewer_port: { review() { calls += 1;
        return { reviewer_identity: "main_session", findings: [] }; } }, completed_at: now });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: "passed", review_execution: { reviewer_identity: "main_session" } });
  });

  it("rejects hostile port descriptors and impossible RFC3339 dates without executing accessors", () => {
    const module = createPlanQualityModule(); const value = trusted("standard"); let probes = 0;
    const evaluator = Object.defineProperty({}, "evaluate", { enumerable: true, get() { probes += 1; return () => []; } });
    expect(() => module.runSemanticGates({ trusted: value, evaluator_port: evaluator as never, completed_at: now }))
      .toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
    expect(() => module.runDeterministicGates({ trusted: value, publication: publication(value),
      stage_verifier_port: stageVerifier(),
      completed_at: "2026-02-30T00:00:00Z" })).toThrowError(expect.objectContaining({
      code: "PLAN_QUALITY_INPUT_INVALID"
    }));
    expect(probes).toBe(0);
  });

  it("rejects Proxy inputs and Proxy ports before any reflection", () => {
    const module = createPlanQualityModule(); const value = trusted("standard"); let traps = 0;
    const input = new Proxy({ trusted: value, completed_at: now }, {
      getPrototypeOf() { traps += 1; throw new Error("proxy trap"); },
      ownKeys() { traps += 1; throw new Error("proxy trap"); }
    });
    expect(() => module.runSemanticGates(input as never)).toThrowError(expect.objectContaining({
      code: "PLAN_QUALITY_INPUT_INVALID"
    }));
    const evaluatorPort = new Proxy({ evaluate() { return []; } }, {
      getPrototypeOf() { traps += 1; throw new Error("proxy trap"); },
      ownKeys() { traps += 1; throw new Error("proxy trap"); }
    });
    expect(() => module.runSemanticGates({ trusted: value, evaluator_port: evaluatorPort as never,
      completed_at: now })).toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
    expect(traps).toBe(0);
  });

  it("derives high-risk scenarios and lenses even if a caller tries to add obsolete self-reported fields", () => {
    const module = createPlanQualityModule(); const value = trusted("assurance");
    const semantic = module.runSemanticGates({ trusted: value, completed_at: now });
    expect(() => module.runAdversarialGates({ trusted: value, semantic, explicit_adversarial: false,
      prefer_delegated: false, completed_at: now, high_risk_findings: [], lens_assessments: [] } as never))
      .toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
    const receipt = module.runAdversarialGates({ trusted: value, semantic, explicit_adversarial: false,
      prefer_delegated: false, completed_at: now });
    expect(receipt.findings.map((finding) => finding.category)).toContain("high_risk_scenario");
  });
});

describe("PlanQualityGate finalization and compatibility", () => {
  it("never emits a success terminal when deterministic publication verification fails", () => {
    const module = createPlanQualityModule(); const value = trusted("quick"); const original = publication(value);
    const files = original.files.map((file, index) => index === 0 ? { ...file,
      serialized_content: `${file.serialized_content}\nTODO`, serialized_hash: testHash(`${file.serialized_content}\nTODO`) } : file);
    const pub = { ...original, files };
    const layer1 = module.runDeterministicGates({ trusted: value, publication: pub,
      stage_verifier_port: stageVerifier(), completed_at: now });
    const layer2 = module.runSemanticGates({ trusted: value, completed_at: now });
    const layer3 = module.runAdversarialGates({ trusted: value, semantic: layer2,
      explicit_adversarial: false, prefer_delegated: false, completed_at: now });
    const final = module.finalizeQuality({ trusted: value, layer1, layer2, layer3,
      ...qualityAnchors(layer1, layer2),
      trusted_review_execution: layer3.review_execution, publication: pub,
      run_id: "run:quality", attempt: 1, phase: "plan", completed_at: now });
    expect(final.receipt).toMatchObject({ status: "blocked", finalizer_action: "none" });
    expect(final.events.map((event) => event.type)).toEqual(["phase_started", "validation_failed", "phase_ended"]);
    expect(final.events.some((event) => event.summary_zh?.includes("协议自检通过") === true)).toBe(false);
  });

  it("emits exact useful events, preserves attempts, and verifies the receipt by reconstruction", () => {
    const module = createPlanQualityModule(); const value = trusted("standard"); const pub = publication(value);
    const layer1 = module.runDeterministicGates({ trusted: value, publication: pub,
      stage_verifier_port: stageVerifier(), completed_at: now });
    const layer2 = module.runSemanticGates({ trusted: value, completed_at: now });
    const layer3 = module.runAdversarialGates({ trusted: value, semantic: layer2,
      explicit_adversarial: false, prefer_delegated: false, completed_at: now });
    const final = module.finalizeQuality({ trusted: value, layer1, layer2, layer3,
      ...qualityAnchors(layer1, layer2),
      trusted_review_execution: layer3.review_execution, publication: pub,
      run_id: "run:quality", attempt: 2, phase: "plan", completed_at: now });
    expect(final.receipt).toMatchObject({ status: "succeeded", finalizer_action: "publish" });
    expect(final.events.map((event) => [event.type, event.attempt, event.producer_seq])).toEqual([
      ["phase_started", 2, 1], ["artifact_published", 2, 2], ["phase_ended", 2, 3]]);
    const execution_identity = { run_id: "run:quality", change_key: value.human.plan.content.change_key,
      phase: "plan" as const, attempt: 2, completed_at: now, publication_intent_id: pub.publication_intent_id };
    expect(module.verifyFinalization({ trusted: value, layer1, layer2, layer3,
      ...qualityAnchors(layer1, layer2),
      trusted_review_execution: layer3.review_execution, publication: pub, execution_identity,
      receipt: final.receipt, events: final.events })).toEqual({ valid: true, reason_code: "PLAN_QUALITY_VALID" });
    expect(module.verifyFinalization({ trusted: value, layer1, layer2, layer3,
      ...qualityAnchors(layer1, layer2),
      trusted_review_execution: layer3.review_execution, publication: pub, execution_identity,
      receipt: { ...final.receipt, finalizer_action: "none" }, events: final.events }))
      .toEqual({ valid: false, reason_code: "PLAN_QUALITY_INVALID" });
    expect(module.verifyFinalization({ trusted: value, layer1, layer2, layer3,
      ...qualityAnchors(layer1, layer2),
      trusted_review_execution: layer3.review_execution, publication: pub,
      execution_identity: { ...execution_identity, attempt: 9 }, receipt: final.receipt, events: final.events }))
      .toEqual({ valid: false, reason_code: "PLAN_QUALITY_INVALID" });
    expect(() => module.finalizeQuality({ trusted: value, layer1, layer2,
      ...qualityAnchors(layer1, layer2),
      layer3: { ...layer3, findings: [{ finding_id: "risk:forged", category: "high_risk_input",
        severity: "advisory", source_refs: ["design.md"], message_zh: "伪造风险", suggested_location: "design.md" }],
        receipt_hash: layer3.receipt_hash },
      trusted_review_execution: layer3.review_execution, publication: pub, run_id: "run:quality", attempt: 2,
      phase: "plan", completed_at: now })).toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
  });

  it("recomputes Layer3 lens references and derived high-risk findings instead of trusting a self-rehashed receipt", () => {
    const module = createPlanQualityModule(); const value = trusted("assurance"); const pub = publication(value);
    const layer1 = module.runDeterministicGates({ trusted: value, publication: pub,
      stage_verifier_port: stageVerifier(), completed_at: now });
    const layer2 = module.runSemanticGates({ trusted: value, completed_at: now });
    const layer3 = module.runAdversarialGates({ trusted: value, semantic: layer2,
      explicit_adversarial: false, prefer_delegated: false, completed_at: now });
    const removed = layer3.findings.find((finding) => finding.category === "high_risk_scenario");
    expect(removed).toBeDefined();
    const lenses = layer3.lenses.map((lens) => lens.lens === "failure_modes" ? { ...lens, finding_refs: ["forged.ref"] } : lens);
    const input_hash = testHash({ artifacts: value, semantic: { input_hash: layer2.input_hash,
      evaluator_invoked: layer2.evaluator_invoked, findings: layer2.findings, status: layer2.status },
      capabilities: [...value.machine_input.capabilities].sort(),
      high_risk_findings_hash: layer3.high_risk_findings_hash, lenses });
    const review_execution = { ...layer3.review_execution, input_hash,
      findings_hash: testHash(layer3.findings.filter((finding) => finding !== removed)) };
    const forged = rehashLayer3({ ...layer3, input_hash, lenses,
      findings: layer3.findings.filter((finding) => finding !== removed), review_execution });
    expect(() => module.finalizeQuality({ trusted: value, layer1, layer2, layer3: forged as never,
      ...qualityAnchors(layer1, layer2), trusted_review_execution: review_execution,
      publication: pub, run_id: "run:quality", attempt: 1, phase: "plan", completed_at: now }))
      .toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
  });

  it("maps a review_unavailable sentinel to blocked/unavailable and never passed/succeeded", () => {
    const module = createPlanQualityModule(); const value = trusted("standard");
    const semantic = module.runSemanticGates({ trusted: value, completed_at: now });
    const result = module.runAdversarialGates({ trusted: value, semantic, explicit_adversarial: true,
      prefer_delegated: false, reviewer_port: { review() {
        return { reviewer_identity: "review_unavailable", findings: [] };
      } }, completed_at: now });
    expect(result).toMatchObject({ status: "blocked", review_execution: {
      reviewer_identity: "review_unavailable", delegation_outcome: "unavailable"
    } });
    expect(result.review_execution.delegation_outcome).not.toBe("succeeded");
  });

  it("does not trust a self-rehashed layer1 stage verification without an external anchor", () => {
    const module = createPlanQualityModule(); const value = trusted("standard"); const pub = publication(value);
    const layer1 = module.runDeterministicGates({ trusted: value, publication: pub,
      stage_verifier_port: stageVerifier(), completed_at: now });
    const layer2 = module.runSemanticGates({ trusted: value, completed_at: now });
    const layer3 = module.runAdversarialGates({ trusted: value, semantic: layer2,
      explicit_adversarial: false, prefer_delegated: false, completed_at: now });
    const stageBody = { ...layer1.stage_verification, atomic_publish_receipt: testHash("foreign") };
    const { evidence_hash: _evidenceHash, ...stageWithoutHash } = stageBody; void _evidenceHash;
    const stage_verification = { ...stageWithoutHash, evidence_hash: testHash(stageWithoutHash) };
    const layerBody = { ...layer1, stage_verification };
    const { receipt_hash: _receiptHash, receipt_id: _receiptId, ...layerWithoutReceipt } = layerBody;
    void _receiptHash; void _receiptId;
    const receipt_hash = testHash(layerWithoutReceipt);
    const forged = { ...layerWithoutReceipt, receipt_hash,
      receipt_id: `plan_quality:layer1:${receipt_hash.slice(7)}` };
    expect(() => module.finalizeQuality({ trusted: value, layer1: forged, layer2, layer3,
      ...qualityAnchors(layer1, layer2),
      trusted_review_execution: layer3.review_execution, publication: pub,
      run_id: "run:quality", attempt: 1, phase: "plan", completed_at: now }))
      .toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
  });

  it("rejects an invalid Layer1 completed_at before rebuilding its receipt", () => {
    const module = createPlanQualityModule(); const value = trusted("standard"); const pub = publication(value);
    const layer1 = module.runDeterministicGates({ trusted: value, publication: pub,
      stage_verifier_port: stageVerifier(), completed_at: now });
    const layer2 = module.runSemanticGates({ trusted: value, completed_at: now });
    const layer3 = module.runAdversarialGates({ trusted: value, semantic: layer2,
      explicit_adversarial: false, prefer_delegated: false, completed_at: now });
    const layer1Body = { ...layer1, completed_at: "not-rfc3339" };
    const { receipt_hash: _receiptHash, receipt_id: _receiptId, ...withoutReceipt } = layer1Body;
    void _receiptHash; void _receiptId;
    const receipt_hash = testHash(withoutReceipt);
    const forged = { ...withoutReceipt, receipt_hash,
      receipt_id: `plan_quality:layer1:${receipt_hash.slice(7)}` };
    expect(() => module.finalizeQuality({ trusted: value, layer1: forged, layer2, layer3,
      ...qualityAnchors(layer1, layer2), trusted_review_execution: layer3.review_execution,
      publication: pub, run_id: "run:quality", attempt: 1, phase: "plan", completed_at: now }))
      .toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
  });

  it("rejects self-rehashed impossible delegation audit states", () => {
    const module = createPlanQualityModule(); const value = trusted("standard"); const pub = publication(value);
    const layer1 = module.runDeterministicGates({ trusted: value, publication: pub,
      stage_verifier_port: stageVerifier(), completed_at: now });
    const layer2 = module.runSemanticGates({ trusted: value, completed_at: now });
    const layer3 = module.runAdversarialGates({ trusted: value, semantic: layer2,
      explicit_adversarial: true, prefer_delegated: false, reviewer_port: { review() {
        return { reviewer_identity: "main_session", findings: [] };
      } }, completed_at: now });
    const impossible = [
      { ...layer3.review_execution, delegation_attempted: true, review_mode: "inline", delegation_outcome: "not_requested" },
      { ...layer3.review_execution, delegation_attempted: false, delegation_outcome: "failed",
        fallback_reason: "delegation_failed" },
      { ...layer3.review_execution, delegation_attempted: true, review_mode: "inline",
        delegation_outcome: "failed", fallback_reason: undefined },
      { ...layer3.review_execution, delegation_attempted: true, review_mode: "delegated",
        delegation_outcome: "failed", fallback_reason: undefined },
      { ...layer3.review_execution, delegation_attempted: true, review_mode: "delegated",
        delegation_outcome: "unavailable", fallback_reason: undefined },
      { ...layer3.review_execution, delegation_attempted: false, review_mode: "delegated",
        delegation_outcome: "succeeded", fallback_reason: undefined },
      { ...layer3.review_execution, reviewer_identity: "review_unavailable",
        delegation_outcome: "not_requested" },
      { ...layer3.review_execution, reviewer_identity: "main_session",
        delegation_outcome: "unavailable" }
    ];
    for (const review_execution of impossible) {
      const forged = rehashLayer3({ ...layer3, review_execution });
      expect(() => module.finalizeQuality({ trusted: value, layer1, layer2, layer3: forged as never,
        ...qualityAnchors(layer1, layer2), trusted_review_execution: review_execution,
        publication: pub, run_id: "run:quality", attempt: 1, phase: "plan", completed_at: now }))
        .toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
    }
  });

  it("normalizes v0 records read-only and rejects hostile descriptors without execution", async () => {
    const module = createPlanQualityModule(); const legacy = JSON.parse(await readFile(
      new URL("./fixtures/plan-quality-v0-legacy.json", import.meta.url), "utf8"));
    const currentFixture = JSON.parse(await readFile(new URL("./fixtures/plan-quality-v1-current.json", import.meta.url), "utf8"));
    expect(currentFixture).toMatchObject({ artifact_schema_version: 2,
      artifact_generator_version: "hunter-harness-plan-artifacts/3", semantic_contract: {
        requirement_kinds: ["behavior", "invariant", "failure_behavior"], task_refs_required: true,
        scenario_refs_required: true, ownership_refs_required: true, evidence_refs_required: true
      } });
    expect(module.normalizeLegacy(legacy)).toMatchObject({ ok: true, source_schema_version: 0,
      readiness: "legacy_read_only" });
    const current = publication(trusted());
    expect(module.runDeterministicGates({ trusted: trusted(), publication: current,
      stage_verifier_port: stageVerifier(), completed_at: now }))
      .toMatchObject({ status: "passed" });
    expect(() => module.runDeterministicGates({ trusted: trusted(), publication: currentFixture,
      stage_verifier_port: stageVerifier(),
      completed_at: now })).toThrowError(expect.objectContaining({ code: "PLAN_QUALITY_INPUT_INVALID" }));
    let probes = 0; const hostile = Object.defineProperty({}, "schemaVersion", { enumerable: true,
      get() { probes += 1; return 0; } });
    expect(module.normalizeLegacy(hostile)).toEqual({ ok: false, reason_code: "PLAN_QUALITY_RECORD_INVALID" });
    expect(probes).toBe(0);
  });
});

describe("PlanEvent serialized bundle verification", () => {
  it("accepts bounded current and terminal bundles through the public seam", async () => {
    const module = createPlanQualityModule();
    const started = planEvent();
    expect(await module.readEventBundle(serializedEventBundle([started]))).toEqual({
      ok: true, mode: "current", source_schema_version: 1,
      value: JSON.parse(serializedEventBundle([started])) as unknown
    });
    const ended = planEvent({ type: "phase_ended", producer_seq: 2,
      occurred_at: "2026-08-13T10:00:01.000Z" });
    const terminal = await module.readEventBundle(serializedEventBundle([started, ended]));
    expect(terminal).toMatchObject({ ok: true, mode: "terminal", source_schema_version: 1,
      value: { lifecycle_kind: "change", run_id: "run:quality", change_key: "change:quality",
        events: [{ type: "phase_started" }, { type: "phase_ended" }] } });
    expect(Object.isFrozen(terminal)).toBe(true);
    expect(Object.isFrozen(terminal.ok && terminal.value.events)).toBe(true);
  });

  it("requires each phase attempt to start once and preserves completed attempts", async () => {
    const module = createPlanQualityModule();
    expect(await module.readEventBundle(serializedEventBundle([
      planEvent({ type: "decision_recorded" })
    ]))).toEqual({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
    const firstEnd = planEvent({ type: "phase_ended", producer_seq: 2,
      occurred_at: "2026-08-13T10:00:01.000Z" });
    const retryStart = planEvent({ attempt: 2, producer_seq: 1,
      occurred_at: "2026-08-13T10:00:02.000Z" });
    expect(await module.readEventBundle(serializedEventBundle([planEvent(), firstEnd, retryStart])))
      .toMatchObject({ ok: true, mode: "current", value: { events: [
        { attempt: 1, type: "phase_started" }, { attempt: 1, type: "phase_ended" },
        { attempt: 2, type: "phase_started" }
      ] } });
    expect(await module.readEventBundle(serializedEventBundle([planEvent(), retryStart])))
      .toEqual({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
    expect(await module.readEventBundle(serializedEventBundle([
      planEvent({ attempt: 2 })
    ]))).toEqual({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
    const planEnd = planEvent({ type: "phase_ended", producer_seq: 2,
      occurred_at: "2026-08-13T10:00:01.000Z" });
    expect(await module.readEventBundle(serializedEventBundle([planEvent(), planEnd,
      planEvent({ phase: "execute", attempt: 37, occurred_at: "2026-08-13T10:00:02.000Z" })])))
      .toEqual({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
    const runStart = planEvent({ phase: "execute", attempt: 1,
      occurred_at: "2026-08-13T10:00:02.000Z" });
    expect(await module.readEventBundle(serializedEventBundle([planEvent(), planEnd, runStart])))
      .toMatchObject({ ok: true, mode: "current", value: { events: [
        { phase: "plan", attempt: 1, type: "phase_started" },
        { phase: "plan", attempt: 1, type: "phase_ended" },
        { phase: "execute", attempt: 1, type: "phase_started" }
      ] } });
    expect(await module.readEventBundle(serializedEventBundle([planEvent(), planEnd,
      planEvent({ type: "risk_found", producer_seq: 3,
        occurred_at: "2026-08-13T10:00:02.000Z" })])))
      .toEqual({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
  });

  it("fails closed for untrusted versions, forged identities, mixed runs, regressions, and resource abuse", async () => {
    const module = createPlanQualityModule(); const valid = serializedEventBundle([planEvent()]);
    expect(await module.readEventBundle({})).toEqual({ ok: false,
      reason_code: "PLAN_EVENT_SERIALIZED_JSON_REQUIRED" });
    expect(await module.readEventBundle("x".repeat(4_000_001))).toEqual({ ok: false,
      reason_code: "PLAN_EVENT_SERIALIZED_JSON_TOO_LARGE" });
    expect(await module.readEventBundle(JSON.stringify({ schema_version: 0, events: [] }))).toEqual({ ok: false,
      reason_code: "PLAN_EVENT_VERSION_UNSUPPORTED" });
    expect(await module.readEventBundle(rehashEventBundle(valid, (value) => {
      const first = (value.events as Record<string, unknown>[])[0];
      if (first === undefined) throw new Error("fixture requires an event");
      first.event_id = "plan_event:" + "0".repeat(64);
    }))).toEqual({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
    expect(await module.readEventBundle(serializedEventBundle([planEvent(), planEvent({ run_id: "run:foreign",
      type: "phase_ended", producer_seq: 2, occurred_at: "2026-08-13T10:00:01.000Z" })])))
      .toEqual({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
    const runStart = planEvent({ phase: "execute", occurred_at: "2026-08-13T10:00:02.000Z" });
    const runEnd = planEvent({ phase: "execute", type: "phase_ended", producer_seq: 2,
      occurred_at: "2026-08-13T10:00:03.000Z" });
    const planStart = planEvent({ occurred_at: "2026-08-13T10:00:04.000Z" });
    expect(await module.readEventBundle(serializedEventBundle([runStart, runEnd, planStart])))
      .toEqual({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
    const end = planEvent({ type: "phase_ended", producer_seq: 2,
      occurred_at: "2026-08-13T10:00:01.000Z" });
    expect(await module.readEventBundle(serializedEventBundle([planEvent(), end,
      planEvent({ attempt: 3, occurred_at: "2026-08-13T10:00:02.000Z" })])))
      .toEqual({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
    expect(await module.readEventBundle(rehashEventBundle(valid, (value) => { value.lifecycle_kind = "sync"; })))
      .toEqual({ ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID" });
  });
});
