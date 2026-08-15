import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { PLAN_PHASES, classifyPlan, configurePlannedPhases } from "../src/plan-classification/index.js";
import { createPlanningContextModule } from "../src/planning-context/index.js";
import {
  createPlanDecisionModule,
  type ApprovalContentInput,
  type DecisionNodeInput,
  type PlanDecisionError
} from "../src/plan-decision/index.js";

const now = "2026-08-13T10:00:00.000Z";
const sha = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as const;
function attackHash(value: unknown): `sha256:${string}` {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) :
    input !== null && typeof input === "object" ? Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .filter(([, child]) => child !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)])) : input;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function planningInputs(mode: "quick" | "standard" | "assurance" = "standard", uncertainties: readonly string[] = []) {
  const signals = mode === "quick" ? ["narrow_fix"] as const : mode === "standard" ?
    ["production_code", "cross_file"] as const : ["security", "payment"] as const;
  const profile = classifyPlan({ schema_version: 1, change_id: `change-10-${mode}`, risk_signals: signals, created_at: now });
  const phase_set = configurePlannedPhases(profile, {
    schema_version: 1, is_git: true, has_remote: true, uses_worktree: false,
    available_phases: PLAN_PHASES, requested_optional_phases: [], requested_omissions: [], configured_at: now
  });
  const planning = createPlanningContextModule();
  const intent = planning.buildIntent({
    schema_version: 1, source_input: "设计审批决策前沿", goal: "收敛产品决策",
    user_visible_outcome: "同轮回答独立问题", in_scope: ["decision_frontier"], out_of_scope: ["cli"],
    constraints: ["no_push"], acceptance_examples: ["独立问题同轮", "依赖问题分轮"], uncertainties, created_at: now
  });
  const evidence = planning.buildEvidenceMap({
    schema_version: 1, map_manifest_hash: sha("a"), sources: [{
      source_kind: "map", source_id: "map:plan", source_version: "v1", content_hash: sha("b"),
      module_refs: ["plan_decision"], symbol_refs: ["DecisionNode"], consumer_refs: [], test_refs: [],
      constraint_refs: ["no_push"], unknown_refs: []
    }], budget: { max_sources: 2, max_refs: 10 }, created_at: now
  });
  const context = planning.buildPlanningContext({ profile, phase_set, intent, evidence, map_manifest_hash: sha("a"), created_at: now });
  return { profile, phase_set, context, intent, evidence };
}

function node(decision_id: string, overrides: Partial<DecisionNodeInput> = {}): DecisionNodeInput {
  return {
    schema_version: 1, decision_id, decision_version: 1, type: "product_decision", depends_on: [], status: "pending",
    question: `如何决定 ${decision_id}？`, recommendation: "采用推荐行为", recommendation_reason: "兼容现有行为",
    tradeoffs: ["兼容性与复杂度"], affected_behaviors: ["product_behavior"], evidence_refs: [], ...overrides
  };
}

function approvalContent(): ApprovalContentInput {
  return {
    goal: "收敛产品决策", user_visible_outcome: "用户一次确认关键行为", in_scope: ["decision_frontier"], out_of_scope: ["cli"],
    recommended_design: "按依赖计算前沿", key_alternatives: ["一次展示全部问题"], invariants: ["事实不询问用户"],
    failure_behaviors: ["超预算暂停"], compatibility_boundaries: ["旧记录只读"],
    risks: [{ risk: "问题过多", mitigation: "按模式限制预算" }],
    acceptance_examples: ["独立问题同轮", "依赖问题分轮", "取消不生成 approved 文档"]
  };
}

const approvalPackageInput = (content: ApprovalContentInput = approvalContent()) => ({ content, created_at: now });

describe("Plan decision Module v1 frontier", () => {
  it("rejects a foreign fact reference before it can reach approval", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs("quick");
    expect(() => module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [node("decision:fact", {
      type: "fact", status: "resolved", question: undefined, recommendation: undefined,
      recommendation_reason: undefined, tradeoffs: [], affected_behaviors: ["compatibility"],
      evidence_refs: [`${inputs.context.evidence_map_ref}#foreign-symbol`], resolution: "伪造事实",
      resolved_by: "evidence", resolved_at: now
    })], evaluated_at: now })).toThrowError(expect.objectContaining({ code: "PLAN_DECISION_INPUT_INVALID" }));
  });

  it("rejects a double-rehashed foreign fact graph and approval package at signing", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs("quick");
    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [node("decision:fact", {
      type: "fact", status: "resolved", question: undefined, recommendation: undefined,
      recommendation_reason: undefined, tradeoffs: [], affected_behaviors: ["compatibility"],
      evidence_refs: [`${inputs.context.evidence_map_ref}#DecisionNode`], resolution: "可信事实",
      resolved_by: "evidence", resolved_at: now
    })], evaluated_at: now });
    const pkg = module.buildApprovalPackage({ schema_version: 1, ...inputs, graph, content: approvalContent(), created_at: now });
    const forgedNodes = graph.nodes.map((item) => ({ ...item,
      evidence_refs: [`${inputs.context.evidence_map_ref}#foreign-symbol`] }));
    const forgedInputHash = attackHash({ ...inputs, nodes: forgedNodes, evaluated_at: graph.evaluated_at });
    const { graph_id: _graphId, input_hash: _inputHash, ...graphRest } = graph;
    void _graphId; void _inputHash;
    const forgedGraphBody = { ...graphRest, nodes: forgedNodes, input_hash: forgedInputHash };
    const forgedGraph = { ...forgedGraphBody, graph_id: `decision_graph:${attackHash(forgedGraphBody).slice(7)}` };
    const approvalInputHash = attackHash({ ...inputs, graph: forgedGraph, content: approvalContent() });
    const { approval_package_id: _packageId, approval_package_hash: _packageHash,
      approval_input_hash: _approvalInputHash, ...packageRest } = pkg;
    void _packageId; void _packageHash; void _approvalInputHash;
    const forgedPackageBody = { ...packageRest, approval_input_hash: approvalInputHash,
      decision_graph_ref: forgedGraph.graph_id };
    const forgedPackageHash = attackHash(forgedPackageBody);
    const forgedPackage = { ...forgedPackageBody, approval_package_hash: forgedPackageHash,
      approval_package_id: `approval_package:${forgedPackageHash.slice(7)}` };
    expect(() => module.recordApproval({ package: forgedPackage, graph: forgedGraph, ...inputs,
      package_input: approvalPackageInput(),
      outcome: "approved", approver_id: "user:owner", decided_at: now }))
      .toThrowError(expect.objectContaining({ code: "PLAN_DECISION_APPROVAL_INVALID" }));
  });

  it("fails closed when PlanningContext decisions_required has no corresponding nodes", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs("standard", ["是否删除旧数据？"]);
    expect(inputs.context.status).toBe("decisions_required");
    expect(() => module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [], evaluated_at: now }))
      .toThrowError(expect.objectContaining({ code: "PLAN_DECISION_INPUT_INVALID" }));
  });

  it("rejects descriptor-hostile public inputs without executing accessors or coercion hooks", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs();
    let probes = 0;
    const hostileEvaluate = { ...inputs, nodes: [], evaluated_at: now } as Record<string, unknown>;
    Object.defineProperty(hostileEvaluate, "schema_version", { enumerable: true, get() { probes += 1; return 1; } });
    expect(() => module.evaluateDecisionGraph(hostileEvaluate as never))
      .toThrowError(expect.objectContaining({ code: "PLAN_DECISION_INPUT_INVALID" }));
    const symbolInput = { schema_version: 1, ...inputs, nodes: [], evaluated_at: now,
      [Symbol("hidden")]: "payload" };
    expect(() => module.evaluateDecisionGraph(symbolInput as never))
      .toThrowError(expect.objectContaining({ code: "PLAN_DECISION_INPUT_INVALID" }));
    const customInput = Object.assign(Object.create({ inherited: true }), {
      schema_version: 1, ...inputs, nodes: [], evaluated_at: now
    });
    expect(() => module.evaluateDecisionGraph(customInput as never))
      .toThrowError(expect.objectContaining({ code: "PLAN_DECISION_INPUT_INVALID" }));
    const hostileNodes = [] as unknown[];
    Object.defineProperty(hostileNodes, "extra", { enumerable: true, value: "payload" });
    expect(() => module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: hostileNodes,
      evaluated_at: now } as never)).toThrowError(expect.objectContaining({ code: "PLAN_DECISION_INPUT_INVALID" }));

    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [], evaluated_at: now });
    const hostileBuild = { schema_version: 1, ...inputs, graph, content: approvalContent(), created_at: now } as Record<string, unknown>;
    Object.defineProperty(hostileBuild, "content", { enumerable: true, get() { probes += 1; return approvalContent(); } });
    expect(() => module.buildApprovalPackage(hostileBuild as never))
      .toThrowError(expect.objectContaining({ code: "PLAN_DECISION_INPUT_INVALID" }));

    const pkg = module.buildApprovalPackage({ schema_version: 1, ...inputs, graph, content: approvalContent(), created_at: now });
    const approval = module.recordApproval({ package: pkg, graph, ...inputs, package_input: approvalPackageInput(),
      outcome: "approved", approver_id: "user:owner", decided_at: now });
    const hostileVerify = { receipt: approval.receipt, package: pkg, ...inputs, graph,
      package_input: approvalPackageInput() } as Record<string, unknown>;
    Object.defineProperty(hostileVerify, "receipt", { enumerable: true, get() { probes += 1; return approval.receipt; } });
    expect(module.verifyApprovalReceipt(hostileVerify as never)).toEqual({ valid: false,
      reason_code: "APPROVAL_RECEIPT_INVALID", approved_design_document: null });

    const hostileRecord = {} as Record<string, unknown>;
    Object.defineProperty(hostileRecord, "schema_version", { enumerable: true, get() { probes += 1; return 1; } });
    expect(module.normalizeRecord(hostileRecord)).toEqual({ ok: false, reason_code: "PLAN_DECISION_RECORD_INVALID" });
    expect(probes).toBe(0);
  });

  it("puts three independent standard questions in one round with complete decision details", () => {
    const module = createPlanDecisionModule();
    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...planningInputs(),
      nodes: [node("decision:a"), node("decision:b"), node("decision:c")], evaluated_at: now });
    expect(graph).toMatchObject({ status: "questions_required", frontier_round: 1,
      question_budget: { minimum: 1, maximum: 3, used: 0, remaining: 3 } });
    expect(graph.current_frontier.map((question) => question.decision_id)).toEqual([
      "decision:a", "decision:b", "decision:c"
    ]);
    expect(graph.current_frontier.every((question) => question.recommendation_reason.length > 0 &&
      question.tradeoffs.length > 0 && question.affected_behaviors.length > 0)).toBe(true);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.current_frontier)).toBe(true);
  });

  it("holds dependent questions until the prior user decision is resolved", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs();
    const first = module.evaluateDecisionGraph({ schema_version: 1, ...inputs,
      nodes: [node("decision:a"), node("decision:b", { depends_on: ["decision:a"] })], evaluated_at: now });
    expect(first.current_frontier.map((item) => item.decision_id)).toEqual(["decision:a"]);
    const second = module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [
      node("decision:a", { status: "resolved", resolution: "采用推荐行为", resolved_by: "user", resolved_at: now }),
      node("decision:b", { depends_on: ["decision:a"] })
    ], evaluated_at: now });
    expect(second.current_frontier.map((item) => item.decision_id)).toEqual(["decision:b"]);
    expect(second).toMatchObject({ frontier_round: 2, question_budget: { used: 1, remaining: 2 } });
  });

  it("resolves facts from Context evidence and engineering defaults without user questions", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs("quick");
    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [
      node("decision:fact", { type: "fact", status: "pending", question: undefined, recommendation: undefined,
        recommendation_reason: undefined, tradeoffs: [], affected_behaviors: ["compatibility"],
        evidence_refs: [`${inputs.context.evidence_map_ref}#DecisionNode`], resolution: "接口已冻结" }),
      node("decision:default", { type: "engineering_default", status: "pending", question: undefined,
        recommendation: "使用项目策略", recommendation_reason: "避免暴露执行配置", tradeoffs: [],
        affected_behaviors: ["execution_policy"] })
    ], evaluated_at: now });
    expect(graph.status).toBe("ready_for_approval");
    expect(graph.current_frontier).toEqual([]);
    expect(graph.nodes.map((item) => [item.decision_id, item.resolved_by])).toEqual([
      ["decision:default", "engineering_default"], ["decision:fact", "evidence"]
    ]);
  });

  it("never turns worktree, planned phases, Agent routing, or coverage into blockers", () => {
    const module = createPlanDecisionModule();
    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...planningInputs(), nodes: [
      node("decision:operational", { affected_behaviors: ["worktree", "planned_phases", "agent_selection", "coverage"] })
    ], evaluated_at: now });
    expect(graph).toMatchObject({ status: "ready_for_approval", current_frontier: [] });
    expect(graph.nodes[0]).toMatchObject({ status: "superseded" });
    expect(graph.nodes[0]).not.toHaveProperty("resolved_by");
  });

  it("pauses with the exact unresolved set when the total budget would be exceeded", () => {
    const module = createPlanDecisionModule();
    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...planningInputs(),
      nodes: ["a", "b", "c", "d"].map((id) => node(`decision:${id}`)), evaluated_at: now });
    expect(graph).toMatchObject({ status: "paused", current_frontier: [], reason_codes: ["question_budget_exceeded"] });
    expect(graph.unresolved_decision_ids).toEqual(["decision:a", "decision:b", "decision:c", "decision:d"]);
  });

  it("caps assurance rounds at three questions and the total frontier budget at seven", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs("assurance");
    const first = module.evaluateDecisionGraph({ schema_version: 1, ...inputs,
      nodes: ["a", "b", "c", "d"].map((id) => node(`decision:${id}`)), evaluated_at: now });
    expect(first).toMatchObject({ status: "questions_required", question_budget: { minimum: 5, maximum: 7 } });
    expect(first.current_frontier).toHaveLength(3);
    const over = module.evaluateDecisionGraph({ schema_version: 1, ...inputs,
      nodes: ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => node(`decision:${id}`)), evaluated_at: now });
    expect(over).toMatchObject({ status: "paused", current_frontier: [], reason_codes: ["question_budget_exceeded"] });
  });

  it("fails closed for unanchored facts, malformed dependencies, and incomplete question details", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs();
    const fact = module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [node("decision:fact", {
      type: "fact", resolution: "伪造事实", evidence_refs: ["foreign:evidence"], question: undefined,
      recommendation: undefined, recommendation_reason: undefined, tradeoffs: []
    })], evaluated_at: now });
    expect(fact).toMatchObject({ status: "not_publishable", reason_codes: ["evidence_or_default_missing"] });
    const incomplete = module.evaluateDecisionGraph({ schema_version: 1, ...inputs,
      nodes: [node("decision:missing", { recommendation_reason: undefined })], evaluated_at: now });
    expect(incomplete).toMatchObject({ status: "not_publishable", reason_codes: ["question_details_missing"] });
    expect(() => module.evaluateDecisionGraph({ schema_version: 1, ...inputs,
      nodes: [node("decision:a", { depends_on: ["decision:missing"] })], evaluated_at: now }))
      .toThrowError(expect.objectContaining<Partial<PlanDecisionError>>({ code: "PLAN_DECISION_DEPENDENCY_INVALID" }));
  });

  it("enforces the resolved_by closure for every decision type", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs("quick");
    for (const resolved_by of ["evidence", "engineering_default"] as const) {
      expect(() => module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [node("decision:product", {
        status: "resolved", resolution: "伪造自动裁决", resolved_by, resolved_at: now
      })], evaluated_at: now })).toThrowError(expect.objectContaining({ code: "PLAN_DECISION_INPUT_INVALID" }));
    }
    expect(() => module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [node("decision:fact", {
      type: "fact", status: "resolved", resolution: "事实", resolved_by: "user", resolved_at: now,
      question: undefined, recommendation: undefined, recommendation_reason: undefined, tradeoffs: [],
      evidence_refs: [inputs.context.evidence_map_ref]
    })], evaluated_at: now })).toThrowError(expect.objectContaining({ code: "PLAN_DECISION_INPUT_INVALID" }));
    expect(() => module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [node("decision:default", {
      type: "engineering_default", status: "resolved", resolution: "默认", resolved_by: "evidence", resolved_at: now
    })], evaluated_at: now })).toThrowError(expect.objectContaining({ code: "PLAN_DECISION_INPUT_INVALID" }));
  });
});

describe("Plan decision Module v1 approval and candidates", () => {
  it("refuses to sign a self-rehashed package with foreign intent or changed goal", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs("quick");
    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [], evaluated_at: now });
    const content = approvalContent();
    const pkg = module.buildApprovalPackage({ schema_version: 1, ...inputs, graph, content, created_at: now });
    const rehash = (changed: Record<string, unknown>) => {
      const { approval_package_id: _id, approval_package_hash: _hash, ...body } = changed;
      void _id; void _hash;
      const approval_package_hash = attackHash(body);
      return { ...body, approval_package_hash,
        approval_package_id: `approval_package:${approval_package_hash.slice(7)}` };
    };
    const foreign = rehash({ ...pkg, intent_contract_ref: `intent:${"f".repeat(64)}` });
    expect(() => module.recordApproval({ package: foreign as never, graph, ...inputs,
      package_input: approvalPackageInput(content), outcome: "approved",
      approver_id: "user:owner", decided_at: now })).toThrowError(expect.objectContaining({
        code: "PLAN_DECISION_APPROVAL_INVALID"
      }));
    const changedGoal = rehash({ ...pkg, sections: { ...pkg.sections,
      goal_and_outcome: { ...pkg.sections.goal_and_outcome, goal: "篡改后的目标" } } });
    expect(() => module.recordApproval({ package: changedGoal as never, graph, ...inputs,
      package_input: approvalPackageInput(content), outcome: "approved",
      approver_id: "user:owner", decided_at: now })).toThrowError(expect.objectContaining({
        code: "PLAN_DECISION_APPROVAL_INVALID"
      }));
  });

  it("never verifies an approved receipt for a graph that is not ready for approval", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs();
    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs,
      nodes: [node("decision:pending")], evaluated_at: now });
    const pkg = module.buildApprovalPackage({ schema_version: 1, ...inputs, graph,
      content: approvalContent(), created_at: now });
    const receiptBody = {
      schema_version: 1 as const, approval_package_ref: pkg.approval_package_id,
      approval_package_hash: pkg.approval_package_hash, approval_input_hash: pkg.approval_input_hash,
      intent_contract_ref: pkg.intent_contract_ref, planning_context_ref: pkg.planning_context_ref,
      plan_profile_ref: pkg.plan_profile_ref, planned_phase_set_ref: pkg.planned_phase_set_ref,
      decision_graph_ref: graph.graph_id, decision_versions: graph.nodes.map(({ decision_id, decision_version }) =>
        ({ decision_id, decision_version })), outcome: "approved" as const, approver_id: "user:owner", decided_at: now
    };
    const receipt = { ...receiptBody, receipt_id: `approval_receipt:${attackHash(receiptBody).slice(7)}` };
    expect(module.verifyApprovalReceipt({ receipt, package: pkg, ...inputs, graph,
      package_input: approvalPackageInput() })).toEqual({
      valid: false, reason_code: "APPROVAL_RECEIPT_INVALID", approved_design_document: null
    });
  });

  it("builds exactly seven approval sections and binds approval to every planning input", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs("quick");
    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [], evaluated_at: now });
    const pkg = module.buildApprovalPackage({ schema_version: 1, ...inputs, graph, content: approvalContent(), created_at: now });
    expect(pkg.status).toBe("ready");
    expect(Object.keys(pkg.sections)).toEqual(["goal_and_outcome", "scope", "design", "boundaries", "risks",
      "acceptance_examples", "unresolved_decisions"]);
    expect(JSON.stringify(pkg.sections)).not.toMatch(/worktree|planned_phases|agent_selection|coverage/u);
    const result = module.recordApproval({ package: pkg, graph, ...inputs, package_input: approvalPackageInput(),
      outcome: "approved", approver_id: "user:owner", decided_at: now });
    expect(result.approved_design_document).toStrictEqual(pkg);
    expect(module.verifyApprovalReceipt({ receipt: result.receipt, package: pkg, ...inputs, graph,
      package_input: approvalPackageInput() }))
      .toMatchObject({ valid: true, reason_code: "APPROVAL_RECEIPT_VALID" });
    const changedGraph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [],
      evaluated_at: "2026-08-13T10:00:01.000Z" });
    expect(module.verifyApprovalReceipt({ receipt: result.receipt, package: pkg, ...inputs, graph: changedGraph,
      package_input: approvalPackageInput() }))
      .toEqual({ valid: false, reason_code: "APPROVAL_INPUT_CHANGED", approved_design_document: null });
  });

  it("does not create an approved document on cancellation or for an unresolved graph", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs();
    const readyGraph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [], evaluated_at: now });
    const readyPackage = module.buildApprovalPackage({ schema_version: 1, ...inputs, graph: readyGraph,
      content: approvalContent(), created_at: now });
    expect(module.recordApproval({ package: readyPackage, graph: readyGraph, ...inputs,
      package_input: approvalPackageInput(), outcome: "cancelled",
      approver_id: "user:owner", decided_at: now }).approved_design_document).toBeNull();
    const rejected = module.recordApproval({ package: readyPackage, graph: readyGraph, ...inputs,
      package_input: approvalPackageInput(), outcome: "rejected",
      approver_id: "user:owner", decided_at: now });
    expect(rejected).toMatchObject({ receipt: { outcome: "rejected" }, approved_design_document: null });
    expect(module.verifyApprovalReceipt({ receipt: rejected.receipt, package: readyPackage, ...inputs,
      graph: readyGraph, package_input: approvalPackageInput() })).toEqual({
      valid: true, reason_code: "APPROVAL_RECEIPT_VALID", approved_design_document: null
    });
    const pendingGraph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs,
      nodes: [node("decision:pending")], evaluated_at: now });
    const pendingPackage = module.buildApprovalPackage({ schema_version: 1, ...inputs, graph: pendingGraph,
      content: approvalContent(), created_at: now });
    expect(pendingPackage.status).toBe("not_publishable");
    expect(() => module.recordApproval({ package: pendingPackage, graph: pendingGraph, ...inputs,
      package_input: approvalPackageInput(), outcome: "approved",
      approver_id: "user:owner", decided_at: now })).toThrowError(expect.objectContaining({ code: "PLAN_DECISION_APPROVAL_INVALID" }));
  });

  it("rejects self-rehashed graph, package, receipt, and invalid calendar timestamps", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs();
    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [node("decision:done", {
      status: "resolved", resolution: "采用推荐行为", resolved_by: "user", resolved_at: now
    })], evaluated_at: now });
    const pkg = module.buildApprovalPackage({ schema_version: 1, ...inputs, graph, content: approvalContent(), created_at: now });
    const result = module.recordApproval({ package: pkg, graph, ...inputs, package_input: approvalPackageInput(),
      outcome: "approved", approver_id: "user:owner", decided_at: now });

    const { graph_id: _graphId, ...forgedGraphBody } = { ...graph, status: "paused" as const };
    void _graphId;
    const forgedGraph = { ...forgedGraphBody, graph_id: `decision_graph:${attackHash(forgedGraphBody).slice(7)}` };
    expect(() => module.buildApprovalPackage({ schema_version: 1, ...inputs, graph: forgedGraph,
      content: approvalContent(), created_at: now })).toThrowError(expect.objectContaining({ code: "PLAN_DECISION_APPROVAL_INVALID" }));

    const { approval_package_id: _packageId, approval_package_hash: _packageHash, ...packageBody } = pkg;
    void _packageId; void _packageHash;
    const alteredPackageBody = { ...packageBody, sections: { ...pkg.sections, worktree: "must_confirm" } };
    const alteredPackageHash = attackHash(alteredPackageBody);
    const alteredPackage = { ...alteredPackageBody, approval_package_hash: alteredPackageHash,
      approval_package_id: `approval_package:${alteredPackageHash.slice(7)}` };
    expect(() => module.recordApproval({ package: alteredPackage as never, graph, ...inputs,
      package_input: approvalPackageInput(), outcome: "approved",
      approver_id: "user:owner", decided_at: now })).toThrowError(expect.objectContaining({ code: "PLAN_DECISION_APPROVAL_INVALID" }));

    const { receipt_id: _receiptId, ...receiptBody } = result.receipt;
    void _receiptId;
    const forgedReceiptBody = { ...receiptBody, decision_versions: [{ decision_id: "decision:done", decision_version: 9 }] };
    const forgedReceipt = { ...forgedReceiptBody, receipt_id: `approval_receipt:${attackHash(forgedReceiptBody).slice(7)}` };
    expect(module.verifyApprovalReceipt({ receipt: forgedReceipt, package: pkg, ...inputs, graph,
      package_input: approvalPackageInput() }))
      .toEqual({ valid: false, reason_code: "APPROVAL_RECEIPT_INVALID", approved_design_document: null });
    expect(() => module.recordApproval({ package: pkg, graph, ...inputs, package_input: approvalPackageInput(),
      outcome: "approved", approver_id: "user:owner",
      decided_at: "2026-02-30T00:00:00Z" })).toThrowError(expect.objectContaining({ code: "PLAN_DECISION_APPROVAL_INVALID" }));
  });

  it("creates only a pending Stage 01 ADR candidate when all three criteria are true", () => {
    const module = createPlanDecisionModule();
    const base = { schema_version: 1 as const, source_change_key: "change-10-standard",
      rationale: "该选择改变长期模块边界", evidence_refs: ["decision_graph:example"],
      proposed_content: "采用决策图作为审批前的唯一问题来源。", confidence: 0.9,
      producer: "hunter_harness_plan", producer_version: "1.0.0", created_at: now,
      irreversible: true, future_maintainer_confusion: true, multiple_viable_alternatives: true };
    const created = module.createArchitectureDecisionCandidate(base);
    expect(created).toMatchObject({ created: true, delivery: "pending_only", candidate: {
      candidate_type: "architecture-decision", status: "pending", provenance: { source_kind: "plan" }
    } });
    expect(module.createArchitectureDecisionCandidate({ ...base, irreversible: false }))
      .toEqual({ created: false, reason_code: "ADR_CRITERIA_NOT_MET" });
    expect(created.created && Object.isFrozen(created.candidate)).toBe(true);
  });

  it("normalizes the current fixture and keeps legacy records read-only and fail-closed", async () => {
    const module = createPlanDecisionModule();
    const [current, legacy] = await Promise.all([
      readFile(new URL("./fixtures/plan-decision-v1-current.json", import.meta.url), "utf8").then(JSON.parse),
      readFile(new URL("./fixtures/plan-decision-v0-legacy.json", import.meta.url), "utf8").then(JSON.parse)
    ]);
    expect(module.normalizeRecord(current)).toEqual({ ok: false, reason_code: "PLAN_DECISION_RECORD_INVALID" });
    expect(module.normalizeRecord(legacy)).toEqual({ ok: true, source_schema_version: 0,
      readiness: "legacy_read_only", legacy_ref: "legacy-plan-decision-42" });
    expect(module.normalizeRecord({ ...legacy, status: "approved" })).toEqual({ ok: false,
      reason_code: "PLAN_DECISION_VERSION_UNSUPPORTED" });
  });

  it("strictly rebuilds a current approval package and keeps approval legacy records read-only", async () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs();
    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [], evaluated_at: now });
    const trusted = { schema_version: 1 as const, ...inputs, graph, content: approvalContent(), created_at: now };
    const [currentFixture, legacy] = await Promise.all([
      readFile(new URL("./fixtures/plan-approval-package-v1-current.json", import.meta.url), "utf8").then(JSON.parse),
      readFile(new URL("./fixtures/plan-approval-package-v0-legacy.json", import.meta.url), "utf8").then(JSON.parse)
    ]);
    expect(currentFixture).toEqual(module.buildApprovalPackage(trusted));
    const current = module.normalizeApprovalPackage(currentFixture, trusted);
    expect(current).toEqual({ ok: true, source_schema_version: 1, readiness: "current",
      package: currentFixture });
    expect(current.ok && current.readiness === "current" && Object.isFrozen(current.package)).toBe(true);
    expect(module.normalizeApprovalPackage(legacy, trusted)).toEqual({ ok: true, source_schema_version: 0,
      readiness: "legacy_read_only", legacy_ref: "legacy-approval-package-42" });
    expect(module.normalizeApprovalPackage({ ...legacy, outcome: "approved" }, trusted)).toEqual({ ok: false,
      reason_code: "APPROVAL_PACKAGE_RECORD_INVALID" });
    expect(module.normalizeApprovalPackage({ schema_version: 9 }, trusted)).toEqual({ ok: false,
      reason_code: "APPROVAL_PACKAGE_VERSION_UNSUPPORTED" });
    expect(module.normalizeApprovalPackage({}, trusted)).toEqual({ ok: false,
      reason_code: "APPROVAL_PACKAGE_RECORD_INVALID" });
  });

  it("rejects a self-consistent foreign package and descriptor-hostile approval records", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs();
    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs, nodes: [], evaluated_at: now });
    const trusted = { schema_version: 1 as const, ...inputs, graph, content: approvalContent(), created_at: now };
    const pkg = module.buildApprovalPackage(trusted);
    const foreignTrusted = { ...trusted, content: { ...trusted.content, goal: "外来目标" } };
    const foreign = module.buildApprovalPackage(foreignTrusted);
    expect(module.normalizeApprovalPackage(foreign, trusted)).toEqual({ ok: false,
      reason_code: "APPROVAL_PACKAGE_RECORD_INVALID" });
    const tampered = { ...pkg, sections: { ...pkg.sections,
      goal_and_outcome: { ...pkg.sections.goal_and_outcome, goal: "篡改目标" } } };
    expect(module.normalizeApprovalPackage(tampered, trusted)).toEqual({ ok: false,
      reason_code: "APPROVAL_PACKAGE_RECORD_INVALID" });
    let probes = 0;
    const hostileRaw = Object.defineProperty({}, "schema_version", { enumerable: true,
      get() { probes += 1; return 1; } });
    const hostileTrusted = Object.defineProperty({ ...trusted }, "content", { enumerable: true,
      get() { probes += 1; return trusted.content; } });
    const proxy = new Proxy(trusted, { get() { probes += 1; throw new Error("trap"); },
      ownKeys() { probes += 1; throw new Error("trap"); } });
    const rawProxy = new Proxy(pkg, { get() { probes += 1; throw new Error("trap"); },
      ownKeys() { probes += 1; throw new Error("trap"); } });
    for (const [raw, binding] of [[hostileRaw, trusted], [rawProxy, trusted], [pkg, hostileTrusted],
      [pkg, proxy]] as const) {
      expect(module.normalizeApprovalPackage(raw, binding as never)).toEqual({ ok: false,
        reason_code: "APPROVAL_PACKAGE_RECORD_INVALID" });
    }
    expect(probes).toBe(0);
  });

  it("rebuilds current graph dependency and frontier semantics instead of trusting a self-hash", () => {
    const module = createPlanDecisionModule();
    const inputs = planningInputs();
    const graph = module.evaluateDecisionGraph({ schema_version: 1, ...inputs,
      nodes: [node("decision:a"), node("decision:b")], evaluated_at: now });
    expect(module.normalizeRecord(graph, inputs)).toMatchObject({ ok: true, readiness: "current" });
    const rehash = (body: Omit<typeof graph, "graph_id">) => ({ ...body,
      graph_id: `decision_graph:${attackHash(body).slice(7)}` });
    const { graph_id: _graphId, ...body } = graph;
    void _graphId;
    const cycleNodes = graph.nodes.map((item) => ({ ...item,
      depends_on: [item.decision_id === "decision:a" ? "decision:b" : "decision:a"] }));
    expect(module.normalizeRecord(rehash({ ...body, nodes: cycleNodes }), inputs)).toEqual({ ok: false,
      reason_code: "PLAN_DECISION_RECORD_INVALID" });
    const unknownNodes = graph.nodes.map((item) => item.decision_id === "decision:a" ?
      { ...item, depends_on: ["decision:missing"] } : item);
    expect(module.normalizeRecord(rehash({ ...body, nodes: unknownNodes }), inputs)).toEqual({ ok: false,
      reason_code: "PLAN_DECISION_RECORD_INVALID" });
    const dependentNodes = graph.nodes.map((item) => item.decision_id === "decision:b" ?
      { ...item, depends_on: ["decision:a"] } : item);
    const earlyQuestion = graph.current_frontier[1];
    if (earlyQuestion === undefined) throw new Error("fixture must contain the second independent question");
    expect(module.normalizeRecord(rehash({ ...body, nodes: dependentNodes,
      current_frontier: [earlyQuestion], frontier_round: 2 }), inputs)).toEqual({ ok: false,
      reason_code: "PLAN_DECISION_RECORD_INVALID" });
  });
});
