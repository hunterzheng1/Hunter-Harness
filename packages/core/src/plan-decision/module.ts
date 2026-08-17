import { projectContentCandidateSchema } from "@hunter-harness/contracts";
import { planProfileSchema, plannedPhaseSetSchema } from "../plan-classification/index.js";
import { evidenceMapSchema, intentContractSchema, planningContextSchema } from "../planning-context/index.js";
import { PlanDecisionError } from "./errors.js";
import {
  boundedText,
  codepointCompare,
  denseArray,
  deepFreeze,
  exact,
  plainRecord,
  sortedUnique,
  snapshotData,
  stableHash,
  strings,
  validTime
} from "./stable.js";
import type {
  ApprovalContentInput,
  ApprovalDecisionResult,
  ApprovalPackage,
  ApprovalPackageInput,
  ApprovalPackageReadResult,
  ApprovalReceipt,
  ArchitectureDecisionCandidateInput,
  DecisionGraph,
  DecisionGraphInput,
  DecisionNode,
  DecisionNodeInput,
  DecisionQuestion,
  PlanDecisionModule,
  ProjectCandidateResult
} from "./types.js";

const nodeTypes = ["fact", "engineering_default", "product_decision", "risk_decision"] as const;
const nodeStatuses = ["pending", "resolved", "blocked", "superseded"] as const;
const nonBlockingBehaviors = new Set(["worktree", "planned_phases", "agent_selection", "change_name", "coverage"]);
const budgets = {
  quick: { minimum: 0, maximum: 1, per_round: 1 },
  standard: { minimum: 1, maximum: 3, per_round: 3 },
  assurance: { minimum: 5, maximum: 7, per_round: 3 }
} as const;

function fail(code: ConstructorParameters<typeof PlanDecisionError>[0]): never {
  throw new PlanDecisionError(code);
}

function validNode(input: unknown): input is DecisionNodeInput {
  if (!plainRecord(input) || !exact(input, ["schema_version", "decision_id", "decision_version", "type",
    "depends_on", "status", "tradeoffs", "affected_behaviors", "evidence_refs"],
  ["question", "recommendation", "recommendation_reason", "resolution", "resolved_by", "resolved_at"]) ||
    input.schema_version !== 1 || !boundedText(input.decision_id, 160) ||
    typeof input.decision_version !== "number" || !Number.isSafeInteger(input.decision_version) || input.decision_version < 1 ||
    !nodeTypes.includes(input.type as never) || !nodeStatuses.includes(input.status as never) ||
    !strings(input.depends_on, 0, 64, 160) || !strings(input.tradeoffs, 0, 16) ||
    !strings(input.affected_behaviors, 0, 32, 256) || !strings(input.evidence_refs, 0, 64, 512)) return false;
  for (const key of ["question", "recommendation", "recommendation_reason", "resolution"] as const) {
    if (input[key] !== undefined && !boundedText(input[key], 2_048)) return false;
  }
  if (input.resolved_by !== undefined && (typeof input.resolved_by !== "string" ||
      !["evidence", "engineering_default", "user"].includes(input.resolved_by))) return false;
  const expectedResolver = input.type === "fact" ? "evidence" : input.type === "engineering_default" ?
    "engineering_default" : "user";
  if (input.resolved_by !== undefined && input.resolved_by !== expectedResolver) return false;
  if (input.resolved_at !== undefined && !validTime(input.resolved_at)) return false;
  if (input.status === "resolved") {
    if (input.resolution === undefined || input.resolved_by === undefined || input.resolved_at === undefined) return false;
    if (input.resolved_by !== expectedResolver) return false;
  }
  if ((input.type === "product_decision" || input.type === "risk_decision") && input.status !== "resolved" &&
      (input.resolution !== undefined || input.resolved_by !== undefined || input.resolved_at !== undefined)) return false;
  return true;
}

function validBindings(input: DecisionGraphInput): boolean {
  if (!plainRecord(input) || !exact(input, ["schema_version", "profile", "phase_set", "context", "intent", "evidence",
    "nodes", "evaluated_at"]) ||
      input.schema_version !== 1 || !planProfileSchema.safeParse(input.profile).success ||
      !plannedPhaseSetSchema.safeParse(input.phase_set).success || !planningContextSchema.safeParse(input.context).success ||
      !intentContractSchema.safeParse(input.intent).success || !evidenceMapSchema.safeParse(input.evidence).success ||
      input.phase_set.outcome !== "configured" || !validTime(input.evaluated_at) || !denseArray(input.nodes)) return false;
  return input.phase_set.profile_classification_hash === input.profile.classification_hash &&
    input.context.plan_profile_ref === input.profile.profile_id &&
    input.context.planned_phase_set_ref === input.phase_set.phase_set_id &&
    input.context.intent_contract_ref === input.intent.intent_id &&
    input.context.evidence_map_ref === input.evidence.evidence_map_id &&
    input.context.partition_hashes.intent === stableHash(input.intent.intent_hash) &&
    input.context.partition_hashes.evidence === stableHash(input.evidence.evidence_map_id) &&
    input.context.partition_hashes.profile === stableHash(input.profile.classification_hash) &&
    input.context.partition_hashes.phases === stableHash(input.phase_set.phase_set_id);
}

function allowedEvidenceRefs(input: DecisionGraphInput): ReadonlySet<string> {
  const refs: string[] = [input.evidence.evidence_map_id];
  if (input.context.partition_hashes.evidence !== null) refs.push(input.context.partition_hashes.evidence);
  for (const source of input.evidence.source_refs) {
    refs.push(source.source_id, source.content_hash, `${input.evidence.evidence_map_id}#${source.source_id}`);
  }
  for (const category of [input.evidence.modules, input.evidence.symbols, input.evidence.consumers,
    input.evidence.tests, input.evidence.constraints, input.evidence.unknowns]) {
    for (const ref of category) refs.push(ref, `${input.evidence.evidence_map_id}#${ref}`);
  }
  return new Set(refs);
}

function normalizeNode(input: DecisionNodeInput, graphInput: DecisionGraphInput, allowed: ReadonlySet<string>): DecisionNode {
  const base = {
    ...input,
    depends_on: sortedUnique(input.depends_on),
    tradeoffs: [...input.tradeoffs],
    affected_behaviors: [...input.affected_behaviors],
    evidence_refs: sortedUnique(input.evidence_refs)
  };
  if (input.affected_behaviors.length > 0 && input.affected_behaviors.every((item) => nonBlockingBehaviors.has(item))) {
    const { resolution: _resolution, resolved_by: _resolvedBy, resolved_at: _resolvedAt, ...superseded } = base;
    void _resolution; void _resolvedBy; void _resolvedAt;
    return { ...superseded, status: "superseded" };
  }
  if (input.type === "fact") {
    const anchored = input.evidence_refs.length > 0 && input.evidence_refs.every((ref) => allowed.has(ref));
    if (anchored && input.resolution !== undefined) return { ...base, status: "resolved", resolved_by: "evidence",
      resolved_at: input.resolved_at ?? graphInput.evaluated_at };
    const { resolution: _resolution, resolved_by: _resolvedBy, resolved_at: _resolvedAt, ...blocked } = base;
    void _resolution; void _resolvedBy; void _resolvedAt;
    return { ...blocked, status: "blocked" };
  }
  if (input.type === "engineering_default") {
    if (input.recommendation === undefined || input.recommendation_reason === undefined) {
      const { resolution: _resolution, resolved_by: _resolvedBy, resolved_at: _resolvedAt, ...blocked } = base;
      void _resolution; void _resolvedBy; void _resolvedAt;
      return { ...blocked, status: "blocked" };
    }
    return { ...base, status: "resolved", resolution: input.resolution ?? input.recommendation,
      resolved_by: "engineering_default", resolved_at: input.resolved_at ?? graphInput.evaluated_at };
  }
  if (input.status === "resolved") return base;
  const { resolution: _resolution, resolved_by: _resolvedBy, resolved_at: _resolvedAt, ...pending } = base;
  void _resolution; void _resolvedBy; void _resolvedAt;
  return { ...pending, status: "pending" };
}

function questionComplete(node: DecisionNode): node is DecisionNode & Required<Pick<DecisionNode,
  "question" | "recommendation" | "recommendation_reason">> {
  return node.question !== undefined && node.recommendation !== undefined &&
    node.recommendation_reason !== undefined && node.tradeoffs.length > 0 && node.affected_behaviors.length > 0;
}

function graphBody(graph: Omit<DecisionGraph, "graph_id">): Omit<DecisionGraph, "graph_id"> {
  return graph;
}

function isDecisionGraph(value: unknown): value is DecisionGraph {
  if (!plainRecord(value) || !exact(value, ["schema_version", "graph_id", "input_hash", "planning_context_ref",
    "plan_profile_ref", "planned_phase_set_ref", "nodes", "frontier_round", "current_frontier",
    "unresolved_decision_ids", "blocked_decision_ids", "question_budget", "status", "reason_codes", "evaluated_at"]) ||
      value.schema_version !== 1 || typeof value.graph_id !== "string" || !/^decision_graph:[a-f0-9]{64}$/u.test(value.graph_id) ||
      typeof value.input_hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.input_hash) ||
      typeof value.planning_context_ref !== "string" || !/^planning_context:[a-f0-9]{64}$/u.test(value.planning_context_ref) ||
      typeof value.plan_profile_ref !== "string" || !/^plan_profile:[a-f0-9]{64}$/u.test(value.plan_profile_ref) ||
      typeof value.planned_phase_set_ref !== "string" || !/^planned_phase_set:[a-f0-9]{64}$/u.test(value.planned_phase_set_ref) ||
      !denseArray(value.nodes) || !(value.nodes as unknown[]).every(validNode) ||
      !denseArray(value.current_frontier) || !strings(value.unresolved_decision_ids, 0, 64, 160) ||
      !strings(value.blocked_decision_ids, 0, 64, 160) || !strings(value.reason_codes, 0, 16, 128) ||
      !validTime(value.evaluated_at) || !plainRecord(value.question_budget) ||
      !exact(value.question_budget, ["minimum", "maximum", "used", "remaining"]) ||
      typeof value.status !== "string" ||
      !["ready_for_approval", "questions_required", "paused", "not_publishable"].includes(value.status)) return false;
  const numeric = [value.frontier_round, value.question_budget.minimum, value.question_budget.maximum,
    value.question_budget.used, value.question_budget.remaining];
  if (!numeric.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)) return false;
  const graph = value as unknown as DecisionGraph;
  const policy = graph.question_budget.minimum === 0 && graph.question_budget.maximum === 1 ? budgets.quick :
    graph.question_budget.minimum === 1 && graph.question_budget.maximum === 3 ? budgets.standard :
      graph.question_budget.minimum === 5 && graph.question_budget.maximum === 7 ? budgets.assurance : undefined;
  if (policy === undefined || graph.question_budget.remaining !== graph.question_budget.maximum - graph.question_budget.used ||
      graph.question_budget.used > graph.question_budget.maximum || graph.current_frontier.length > policy.per_round) return false;
  const nodes = graph.nodes;
  const nodeIds = nodes.map((node) => node.decision_id);
  if (new Set(nodeIds).size !== nodeIds.length ||
      JSON.stringify(nodeIds) !== JSON.stringify([...nodeIds].sort(codepointCompare))) return false;
  const byId = new Map(nodes.map((node) => [node.decision_id, node]));
  if (nodes.some((node) => JSON.stringify(node.depends_on) !== JSON.stringify(sortedUnique(node.depends_on)) ||
      JSON.stringify(node.evidence_refs) !== JSON.stringify(sortedUnique(node.evidence_refs)) ||
      node.depends_on.some((dependency) => !byId.has(dependency)) ||
      ((node.type === "fact" || node.type === "engineering_default") && node.status === "pending") ||
      ((node.type === "product_decision" || node.type === "risk_decision") && node.status === "blocked") ||
      (node.status === "superseded" && (node.affected_behaviors.length === 0 ||
        !node.affected_behaviors.every((behavior) => nonBlockingBehaviors.has(behavior)))))) return false;
  const levels = new Map<string, number>();
  function decisionLevel(id: string, visiting: ReadonlySet<string> = new Set()): number {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return Number.POSITIVE_INFINITY;
    const node = byId.get(id);
    if (node === undefined) return Number.POSITIVE_INFINITY;
    const next = new Set(visiting); next.add(id);
    const result = node.depends_on.length === 0 ? 1 :
      1 + Math.max(...node.depends_on.map((dependency) => decisionLevel(dependency, next)));
    levels.set(id, result);
    return result;
  }
  if (nodes.some((node) => !Number.isFinite(decisionLevel(node.decision_id)))) return false;
  const resolved = new Set(nodes.filter((node) => node.status === "resolved" || node.status === "superseded")
    .map((node) => node.decision_id));
  const pendingUser = nodes.filter((node) => (node.type === "product_decision" || node.type === "risk_decision") &&
    node.status === "pending");
  const eligible = pendingUser.filter((node) => node.depends_on.every((dependency) => resolved.has(dependency)));
  const invalidQuestions = eligible.filter((node) => !questionComplete(node));
  const blockedFacts = nodes.filter((node) => (node.type === "fact" || node.type === "engineering_default") &&
    node.status === "blocked").map((node) => node.decision_id);
  const unresolved = nodes.filter((node) => node.status !== "resolved" && node.status !== "superseded")
    .map((node) => node.decision_id);
  const actualUsed = nodes.filter((node) => (node.type === "product_decision" || node.type === "risk_decision") &&
    node.status === "resolved" && node.resolved_by === "user").length;
  if (graph.question_budget.used !== actualUsed) return false;
  const wouldExceed = eligible.length > graph.question_budget.remaining ||
    (eligible.length === 0 && unresolved.length > 0 && graph.question_budget.remaining === 0);
  const structurallyInvalid = invalidQuestions.length > 0 || blockedFacts.length > 0;
  const expectedFrontierNodes = structurallyInvalid || wouldExceed ? [] :
    eligible.slice(0, Math.min(policy.per_round, graph.question_budget.remaining));
  const expectedQuestions: readonly DecisionQuestion[] = expectedFrontierNodes.map((node) => {
    const { question, recommendation, recommendation_reason } = node;
    if (!questionComplete(node) || question === undefined || recommendation === undefined ||
        recommendation_reason === undefined) return fail("PLAN_DECISION_INPUT_INVALID");
    return { decision_id: node.decision_id, decision_version: node.decision_version, question, recommendation,
      recommendation_reason, tradeoffs: [...node.tradeoffs], affected_behaviors: [...node.affected_behaviors] };
  });
  const expectedReasons = [
    ...(blockedFacts.length > 0 ? ["evidence_or_default_missing"] : []),
    ...(invalidQuestions.length > 0 ? ["question_details_missing"] : []),
    ...(wouldExceed ? ["question_budget_exceeded"] : [])
  ];
  const expectedStatus = structurallyInvalid ? "not_publishable" : wouldExceed ? "paused" :
    unresolved.length === 0 ? "ready_for_approval" : expectedQuestions.length > 0 ?
      "questions_required" : "not_publishable";
  const expectedRound = expectedFrontierNodes.length === 0 ? 0 :
    Math.min(...expectedFrontierNodes.map((node) => decisionLevel(node.decision_id)));
  const questions = graph.current_frontier as unknown[];
  if (questions.some((question) => {
    if (!plainRecord(question) || !exact(question, ["decision_id", "decision_version", "question", "recommendation",
      "recommendation_reason", "tradeoffs", "affected_behaviors"]) || !boundedText(question.decision_id, 160) ||
      typeof question.decision_version !== "number" || !Number.isSafeInteger(question.decision_version) || question.decision_version < 1 ||
      !boundedText(question.question) || !boundedText(question.recommendation) || !boundedText(question.recommendation_reason) ||
      !strings(question.tradeoffs, 1, 16) || !strings(question.affected_behaviors, 1, 32, 256)) return true;
    const node = byId.get(question.decision_id as string);
    return node === undefined || node.status !== "pending" || node.decision_version !== question.decision_version ||
      node.question !== question.question || node.recommendation !== question.recommendation ||
      node.recommendation_reason !== question.recommendation_reason ||
      JSON.stringify(node.tradeoffs) !== JSON.stringify(question.tradeoffs) ||
      JSON.stringify(node.affected_behaviors) !== JSON.stringify(question.affected_behaviors);
  })) return false;
  const questionIds = (questions as Record<string, unknown>[]).map((question) => question.decision_id as string);
  if (new Set(questionIds).size !== questionIds.length ||
      JSON.stringify(questionIds) !== JSON.stringify([...questionIds].sort(codepointCompare))) return false;
  if (JSON.stringify(graph.unresolved_decision_ids) !== JSON.stringify(sortedUnique(unresolved)) ||
      JSON.stringify(graph.blocked_decision_ids) !== JSON.stringify(sortedUnique(blockedFacts)) ||
      stableHash(graph.current_frontier) !== stableHash(expectedQuestions) || graph.frontier_round !== expectedRound ||
      graph.status !== expectedStatus || JSON.stringify(graph.reason_codes) !== JSON.stringify(expectedReasons)) return false;
  const { graph_id, ...body } = value;
  return graph_id === `decision_graph:${stableHash(body).slice(7)}`;
}

function evaluateDecisionGraphCanonical(input: DecisionGraphInput): DecisionGraph {
  if (!validBindings(input) || input.nodes.length > 64 || !(input.nodes as readonly unknown[]).every(validNode)) {
    return fail("PLAN_DECISION_INPUT_INVALID");
  }
  const ids = input.nodes.map((node) => node.decision_id);
  if (new Set(ids).size !== ids.length) return fail("PLAN_DECISION_DEPENDENCY_INVALID");
  const idSet = new Set(ids);
  if (input.context.unresolved_decision_ids.some((decisionId) => !idSet.has(decisionId))) {
    return fail("PLAN_DECISION_INPUT_INVALID");
  }
  if (input.nodes.some((node) => node.depends_on.includes(node.decision_id) || node.depends_on.some((id) => !idSet.has(id)))) {
    return fail("PLAN_DECISION_DEPENDENCY_INVALID");
  }
  const allowed = allowedEvidenceRefs(input);
  if (input.nodes.some((node) => node.type === "fact" && node.status === "resolved" &&
      node.evidence_refs.some((evidenceRef) => !allowed.has(evidenceRef)))) {
    return fail("PLAN_DECISION_INPUT_INVALID");
  }
  const nodes = input.nodes.map((node) => normalizeNode(node, input, allowed))
    .sort((left, right) => codepointCompare(left.decision_id, right.decision_id));
  const byId = new Map(nodes.map((node) => [node.decision_id, node]));
  const resolved = new Set(nodes.filter((node) => node.status === "resolved" || node.status === "superseded")
    .map((node) => node.decision_id));
  const pendingUser = nodes.filter((node) => (node.type === "product_decision" || node.type === "risk_decision") &&
    node.status === "pending");
  const eligible = pendingUser.filter((node) => node.depends_on.every((id) => resolved.has(id)));
  const invalidQuestions = eligible.filter((node) => !questionComplete(node));
  const used = nodes.filter((node) => (node.type === "product_decision" || node.type === "risk_decision") &&
    node.status === "resolved" && node.resolved_by === "user").length;
  const policy = budgets[input.profile.mode];
  const remaining = Math.max(0, policy.maximum - used);
  const contextMissing = input.context.unresolved_decision_ids.filter((id) => !idSet.has(id));
  const blockedFacts = nodes.filter((node) => (node.type === "fact" || node.type === "engineering_default") &&
    node.status === "blocked").map((node) => node.decision_id);

  const levels = new Map<string, number>();
  function level(id: string, visiting: ReadonlySet<string> = new Set()): number {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return Number.POSITIVE_INFINITY;
    const node = byId.get(id);
    if (node === undefined) return Number.POSITIVE_INFINITY;
    const next = new Set(visiting); next.add(id);
    const value = node.depends_on.length === 0 ? 1 : 1 + Math.max(...node.depends_on.map((dep) => level(dep, next)));
    levels.set(id, value);
    return value;
  }
  const cyclic = nodes.filter((node) => !Number.isFinite(level(node.decision_id))).map((node) => node.decision_id);
  const unresolved = nodes.filter((node) => node.status !== "resolved" && node.status !== "superseded")
    .map((node) => node.decision_id);
  const wouldExceed = eligible.length > remaining || (eligible.length === 0 && unresolved.length > 0 && remaining === 0);
  const structurallyInvalid = invalidQuestions.length > 0 || blockedFacts.length > 0 || cyclic.length > 0 || contextMissing.length > 0;
  const frontierNodes = structurallyInvalid || wouldExceed ? [] : eligible.slice(0, Math.min(policy.per_round, remaining));
  const current_frontier: readonly DecisionQuestion[] = frontierNodes.map((node) => {
    const { question, recommendation, recommendation_reason } = node;
    if (!questionComplete(node) || question === undefined || recommendation === undefined ||
        recommendation_reason === undefined) return fail("PLAN_DECISION_INPUT_INVALID");
    return {
      decision_id: node.decision_id,
      decision_version: node.decision_version,
      question,
      recommendation,
      recommendation_reason,
      tradeoffs: [...node.tradeoffs],
      affected_behaviors: [...node.affected_behaviors]
    };
  });
  const reasonCodes = [
    ...(contextMissing.length > 0 ? ["context_decision_missing"] : []),
    ...(blockedFacts.length > 0 ? ["evidence_or_default_missing"] : []),
    ...(invalidQuestions.length > 0 ? ["question_details_missing"] : []),
    ...(cyclic.length > 0 ? ["decision_cycle"] : []),
    ...(wouldExceed ? ["question_budget_exceeded"] : [])
  ];
  const status = structurallyInvalid ? "not_publishable" as const : wouldExceed ? "paused" as const :
    unresolved.length === 0 ? "ready_for_approval" as const : current_frontier.length > 0 ?
      "questions_required" as const : "not_publishable" as const;
  const normalizedNodes = nodes.map((node) => deepFreeze({ ...node }));
  const input_hash = stableHash({ profile: input.profile, phase_set: input.phase_set, context: input.context,
    intent: input.intent, evidence: input.evidence, nodes: normalizedNodes, evaluated_at: input.evaluated_at });
  const body = graphBody({
    schema_version: 1,
    input_hash,
    planning_context_ref: input.context.context_id,
    plan_profile_ref: input.profile.profile_id,
    planned_phase_set_ref: input.phase_set.phase_set_id,
    nodes: normalizedNodes,
    frontier_round: current_frontier.length === 0 ? 0 : Math.min(...frontierNodes.map((node) => level(node.decision_id))),
    current_frontier,
    unresolved_decision_ids: sortedUnique(unresolved),
    blocked_decision_ids: sortedUnique([...blockedFacts, ...cyclic, ...contextMissing]),
    question_budget: { minimum: policy.minimum, maximum: policy.maximum, used, remaining },
    status,
    reason_codes: reasonCodes,
    evaluated_at: input.evaluated_at
  });
  return deepFreeze({ ...body, graph_id: `decision_graph:${stableHash(body).slice(7)}` });
}

function validContent(content: unknown): content is ApprovalContentInput {
  if (!plainRecord(content) || !exact(content, ["goal", "user_visible_outcome", "in_scope", "out_of_scope",
    "recommended_design", "key_alternatives", "invariants", "failure_behaviors", "compatibility_boundaries",
    "risks", "acceptance_examples"]) || !boundedText(content.goal, 1_024) ||
    !boundedText(content.user_visible_outcome, 1_024) || !strings(content.in_scope, 1, 32) ||
    !strings(content.out_of_scope, 0, 32) || !boundedText(content.recommended_design, 8_192) ||
    !strings(content.key_alternatives, 1, 16, 4_096) || !strings(content.invariants, 1, 32) ||
    !strings(content.failure_behaviors, 1, 32) || !strings(content.compatibility_boundaries, 1, 32) ||
    !Array.isArray(content.risks) || content.risks.length > 16 ||
    !(content.risks as unknown[]).every((risk) => plainRecord(risk) && exact(risk, ["risk", "mitigation"]) &&
      boundedText(risk.risk, 2_048) && boundedText(risk.mitigation, 2_048)) ||
    !strings(content.acceptance_examples, 3, 7, 2_048)) return false;
  return true;
}

function approvalInputHash(input: Pick<ApprovalPackageInput, "profile" | "phase_set" | "context" | "intent" | "evidence" |
  "graph" | "content">): string {
  return stableHash({ profile: input.profile, phase_set: input.phase_set, context: input.context,
    intent: input.intent, evidence: input.evidence, graph: input.graph, content: input.content });
}

function graphMatchesPlanningInputs(input: Pick<ApprovalPackageInput, "profile" | "phase_set" | "context" | "intent" | "evidence" |
  "graph">): boolean {
  if (!(input.graph.plan_profile_ref === input.profile.profile_id &&
    input.graph.planned_phase_set_ref === input.phase_set.phase_set_id &&
    input.graph.planning_context_ref === input.context.context_id &&
    input.graph.input_hash === stableHash({ profile: input.profile, phase_set: input.phase_set, context: input.context,
      intent: input.intent, evidence: input.evidence, nodes: input.graph.nodes, evaluated_at: input.graph.evaluated_at }))) return false;
  try {
    const expected = evaluateDecisionGraphCanonical({ schema_version: 1, profile: input.profile, phase_set: input.phase_set,
      context: input.context, intent: input.intent, evidence: input.evidence, nodes: input.graph.nodes,
      evaluated_at: input.graph.evaluated_at });
    return stableHash(expected) === stableHash(input.graph);
  } catch {
    return false;
  }
}

function canonicalApprovalPackage(input: ApprovalPackageInput): ApprovalPackage {
  if (!plainRecord(input) || !exact(input, ["schema_version", "profile", "phase_set", "context", "intent", "evidence",
    "graph", "content", "created_at"]) ||
      input.schema_version !== 1 || !validBindings({ schema_version: 1, profile: input.profile, phase_set: input.phase_set,
        context: input.context, intent: input.intent, evidence: input.evidence, nodes: input.graph.nodes,
        evaluated_at: input.graph.evaluated_at }) ||
      !isDecisionGraph(input.graph) || input.graph.planning_context_ref !== input.context.context_id ||
      input.graph.plan_profile_ref !== input.profile.profile_id || input.graph.planned_phase_set_ref !== input.phase_set.phase_set_id ||
      !graphMatchesPlanningInputs(input) ||
      !validContent(input.content) || !validTime(input.created_at)) return fail("PLAN_DECISION_APPROVAL_INVALID");
  const approval_input_hash = approvalInputHash(input);
  const sections = {
    goal_and_outcome: { goal: input.content.goal, user_visible_outcome: input.content.user_visible_outcome },
    // HP-04：scope 是集合语义——构造即 canonical（顺序不参与身份/质量判定）
    scope: { in_scope: sortedUnique(input.content.in_scope), out_of_scope: sortedUnique(input.content.out_of_scope) },
    design: { recommended_design: input.content.recommended_design, key_alternatives: [...input.content.key_alternatives] },
    boundaries: { invariants: [...input.content.invariants], failure_behaviors: [...input.content.failure_behaviors],
      compatibility_boundaries: [...input.content.compatibility_boundaries] },
    risks: input.content.risks.map((risk) => ({ ...risk })),
    acceptance_examples: [...input.content.acceptance_examples],
    unresolved_decisions: [...input.graph.unresolved_decision_ids]
  };
  const body = {
    schema_version: 1 as const,
    approval_input_hash,
    intent_contract_ref: input.context.intent_contract_ref,
    planning_context_ref: input.context.context_id,
    plan_profile_ref: input.profile.profile_id,
    planned_phase_set_ref: input.phase_set.phase_set_id,
    decision_graph_ref: input.graph.graph_id,
    status: input.graph.status === "ready_for_approval" ? "ready" as const : "not_publishable" as const,
    sections,
    created_at: input.created_at
  };
  const approval_package_hash = stableHash(body);
  return deepFreeze({ ...body, approval_package_hash,
    approval_package_id: `approval_package:${approval_package_hash.slice(7)}` });
}

function packageValid(value: unknown): value is ApprovalPackage {
  if (!plainRecord(value) || !exact(value, ["schema_version", "approval_package_id", "approval_package_hash",
    "approval_input_hash", "intent_contract_ref", "planning_context_ref", "plan_profile_ref",
    "planned_phase_set_ref", "decision_graph_ref", "status", "sections", "created_at"]) || value.schema_version !== 1 ||
    typeof value.approval_package_id !== "string" || !/^approval_package:[a-f0-9]{64}$/u.test(value.approval_package_id) ||
    typeof value.approval_package_hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.approval_package_hash) ||
    typeof value.approval_input_hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.approval_input_hash) ||
    typeof value.intent_contract_ref !== "string" || !/^intent:[a-f0-9]{64}$/u.test(value.intent_contract_ref) ||
    typeof value.planning_context_ref !== "string" || !/^planning_context:[a-f0-9]{64}$/u.test(value.planning_context_ref) ||
    typeof value.plan_profile_ref !== "string" || !/^plan_profile:[a-f0-9]{64}$/u.test(value.plan_profile_ref) ||
    typeof value.planned_phase_set_ref !== "string" || !/^planned_phase_set:[a-f0-9]{64}$/u.test(value.planned_phase_set_ref) ||
    typeof value.decision_graph_ref !== "string" || !/^decision_graph:[a-f0-9]{64}$/u.test(value.decision_graph_ref) ||
    !validTime(value.created_at) || (value.status !== "ready" && value.status !== "not_publishable") ||
    !plainRecord(value.sections) || !exact(value.sections, ["goal_and_outcome", "scope", "design", "boundaries",
      "risks", "acceptance_examples", "unresolved_decisions"])) return false;
  const sections = value.sections;
  if (!plainRecord(sections.goal_and_outcome) || !exact(sections.goal_and_outcome, ["goal", "user_visible_outcome"]) ||
      !boundedText(sections.goal_and_outcome.goal, 1_024) || !boundedText(sections.goal_and_outcome.user_visible_outcome, 1_024) ||
      !plainRecord(sections.scope) || !exact(sections.scope, ["in_scope", "out_of_scope"]) ||
      !strings(sections.scope.in_scope, 1, 32) || !strings(sections.scope.out_of_scope, 0, 32) ||
      !plainRecord(sections.design) || !exact(sections.design, ["recommended_design", "key_alternatives"]) ||
      !boundedText(sections.design.recommended_design, 8_192) || !strings(sections.design.key_alternatives, 1, 16, 4_096) ||
      !plainRecord(sections.boundaries) || !exact(sections.boundaries,
        ["invariants", "failure_behaviors", "compatibility_boundaries"]) ||
      !strings(sections.boundaries.invariants, 1, 32) || !strings(sections.boundaries.failure_behaviors, 1, 32) ||
      !strings(sections.boundaries.compatibility_boundaries, 1, 32) ||
      !denseArray(sections.risks) || sections.risks.length > 16 || sections.risks.some((risk) =>
        !plainRecord(risk) || !exact(risk, ["risk", "mitigation"]) || !boundedText(risk.risk) || !boundedText(risk.mitigation)) ||
      !strings(sections.acceptance_examples, 3, 7) || !strings(sections.unresolved_decisions, 0, 64, 160) ||
      (value.status === "ready" && sections.unresolved_decisions.length > 0)) return false;
  const { approval_package_id, approval_package_hash, ...body } = value;
  const hash = stableHash(body);
  return approval_package_hash === hash && approval_package_id === `approval_package:${hash.slice(7)}`;
}

function receiptBody(pkg: ApprovalPackage, graph: DecisionGraph, outcome: ApprovalReceipt["outcome"],
  approver_id: string, decided_at: string): Omit<ApprovalReceipt, "receipt_id"> {
  return {
    schema_version: 1,
    approval_package_ref: pkg.approval_package_id,
    approval_package_hash: pkg.approval_package_hash,
    approval_input_hash: pkg.approval_input_hash,
    intent_contract_ref: pkg.intent_contract_ref,
    planning_context_ref: pkg.planning_context_ref,
    plan_profile_ref: pkg.plan_profile_ref,
    planned_phase_set_ref: pkg.planned_phase_set_ref,
    decision_graph_ref: graph.graph_id,
    decision_versions: graph.nodes.map((node) => ({ decision_id: node.decision_id, decision_version: node.decision_version })),
    outcome,
    approver_id,
    decided_at
  };
}

function approvalOutcomeDocument(outcome: ApprovalReceipt["outcome"], pkg: ApprovalPackage,
  graph: DecisionGraph): ApprovalPackage | null | undefined {
  const eligible = graph.status === "ready_for_approval" && graph.unresolved_decision_ids.length === 0 &&
    graph.blocked_decision_ids.length === 0 && pkg.status === "ready" && pkg.sections.unresolved_decisions.length === 0;
  if (outcome === "approved") return eligible ? pkg : undefined;
  if (outcome === "cancelled" || outcome === "rejected") return null;
  return undefined;
}

function recordApprovalCanonical(input: Parameters<PlanDecisionModule["recordApproval"]>[0]): ApprovalDecisionResult {
  if (!plainRecord(input) || !exact(input, ["package", "graph", "profile", "phase_set", "context", "intent", "evidence",
    "package_input", "outcome", "approver_id", "decided_at"]) ||
      !packageValid(input.package) || !isDecisionGraph(input.graph) ||
      (input.outcome !== "approved" && input.outcome !== "cancelled" && input.outcome !== "rejected") ||
      !plainRecord(input.package_input) || !exact(input.package_input, ["content", "created_at"]) ||
      !boundedText(input.approver_id, 256) ||
      !validTime(input.decided_at) || input.package.decision_graph_ref !== input.graph.graph_id ||
      !graphMatchesPlanningInputs(input)) {
    return fail("PLAN_DECISION_APPROVAL_INVALID");
  }
  const expectedPackage = canonicalApprovalPackage({ schema_version: 1, profile: input.profile,
    phase_set: input.phase_set, context: input.context, intent: input.intent, evidence: input.evidence,
    graph: input.graph, content: input.package_input.content, created_at: input.package_input.created_at });
  if (stableHash(expectedPackage) !== stableHash(input.package)) return fail("PLAN_DECISION_APPROVAL_INVALID");
  const approvedDocument = approvalOutcomeDocument(input.outcome, expectedPackage, input.graph);
  if (approvedDocument === undefined) return fail("PLAN_DECISION_APPROVAL_INVALID");
  const body = receiptBody(expectedPackage, input.graph, input.outcome, input.approver_id, input.decided_at);
  const receipt = deepFreeze({ ...body, receipt_id: `approval_receipt:${stableHash(body).slice(7)}` });
  return deepFreeze({ receipt, approved_design_document: approvedDocument });
}

function receiptShape(value: unknown): value is ApprovalReceipt {
  return plainRecord(value) && exact(value, ["schema_version", "receipt_id", "approval_package_ref",
    "approval_package_hash", "approval_input_hash", "intent_contract_ref", "planning_context_ref",
    "plan_profile_ref", "planned_phase_set_ref", "decision_graph_ref", "decision_versions", "outcome",
    "approver_id", "decided_at"]) && value.schema_version === 1 && boundedText(value.approver_id, 256) &&
    validTime(value.decided_at) && (value.outcome === "approved" || value.outcome === "cancelled" ||
      value.outcome === "rejected") &&
    typeof value.receipt_id === "string" && /^approval_receipt:[a-f0-9]{64}$/u.test(value.receipt_id) &&
    denseArray(value.decision_versions) && (value.decision_versions as unknown[]).every((version) =>
      plainRecord(version) && exact(version, ["decision_id", "decision_version"]) && boundedText(version.decision_id, 160) &&
      typeof version.decision_version === "number" && Number.isSafeInteger(version.decision_version) && version.decision_version > 0);
}

function verifyApprovalReceiptCanonical(input: Parameters<PlanDecisionModule["verifyApprovalReceipt"]>[0]) {
  if (!plainRecord(input) || !exact(input, ["receipt", "package", "profile", "phase_set", "context", "intent", "evidence",
    "graph", "package_input"]) ||
      !receiptShape(input.receipt) || !packageValid(input.package) || !isDecisionGraph(input.graph)) {
    return deepFreeze({ valid: false, reason_code: "APPROVAL_RECEIPT_INVALID" as const, approved_design_document: null });
  }
  if (!graphMatchesPlanningInputs(input)) {
    return deepFreeze({ valid: false, reason_code: "APPROVAL_INPUT_CHANGED" as const, approved_design_document: null });
  }
  let expectedPackage: ApprovalPackage;
  try {
    expectedPackage = canonicalApprovalPackage({ schema_version: 1, profile: input.profile,
      phase_set: input.phase_set, context: input.context, intent: input.intent, evidence: input.evidence,
      graph: input.graph, content: input.package_input.content, created_at: input.package_input.created_at });
  } catch {
    return deepFreeze({ valid: false, reason_code: "APPROVAL_INPUT_CHANGED" as const, approved_design_document: null });
  }
  if (stableHash(expectedPackage) !== stableHash(input.package)) {
    return deepFreeze({ valid: false, reason_code: "APPROVAL_INPUT_CHANGED" as const, approved_design_document: null });
  }
  const approvedDocument = approvalOutcomeDocument(input.receipt.outcome, expectedPackage, input.graph);
  if (approvedDocument === undefined) {
    return deepFreeze({ valid: false, reason_code: "APPROVAL_RECEIPT_INVALID" as const, approved_design_document: null });
  }
  const expectedBody = receiptBody(expectedPackage, input.graph, input.receipt.outcome,
    input.receipt.approver_id, input.receipt.decided_at);
  const expected = { ...expectedBody, receipt_id: `approval_receipt:${stableHash(expectedBody).slice(7)}` };
  if (stableHash(expected) !== stableHash(input.receipt)) {
    return deepFreeze({ valid: false, reason_code: "APPROVAL_RECEIPT_INVALID" as const, approved_design_document: null });
  }
  return deepFreeze({ valid: true, reason_code: "APPROVAL_RECEIPT_VALID" as const,
    approved_design_document: approvedDocument });
}

function createArchitectureDecisionCandidateCanonical(input: ArchitectureDecisionCandidateInput): ProjectCandidateResult {
  if (!plainRecord(input) || !exact(input, ["schema_version", "source_change_key", "rationale", "evidence_refs",
    "proposed_content", "confidence", "producer", "producer_version", "created_at", "irreversible",
    "future_maintainer_confusion", "multiple_viable_alternatives"]) || input.schema_version !== 1 ||
      !boundedText(input.source_change_key, 160) || !boundedText(input.rationale, 2_048) ||
      !strings(input.evidence_refs, 1, 64, 512) || !boundedText(input.proposed_content, 16_384) ||
      typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 1 ||
      !boundedText(input.producer, 256) || !boundedText(input.producer_version, 128) || !validTime(input.created_at) ||
      typeof input.irreversible !== "boolean" || typeof input.future_maintainer_confusion !== "boolean" ||
      typeof input.multiple_viable_alternatives !== "boolean") return fail("PLAN_DECISION_CANDIDATE_INVALID");
  if (!input.irreversible || !input.future_maintainer_confusion || !input.multiple_viable_alternatives) {
    return deepFreeze({ created: false, reason_code: "ADR_CRITERIA_NOT_MET" });
  }
  const content_hash = stableHash(input.proposed_content);
  const candidateBody = {
    schema_version: 1 as const,
    source_change_key: input.source_change_key,
    content_hash,
    confidence: input.confidence,
    provenance: { source_kind: "plan" as const, source_ref: input.source_change_key, producer: input.producer,
      producer_version: input.producer_version, created_at: input.created_at },
    candidate_type: "architecture-decision" as const,
    evidence_refs: sortedUnique(input.evidence_refs),
    rationale: input.rationale,
    proposed_content: input.proposed_content,
    status: "pending" as const
  };
  const candidate = { ...candidateBody, candidate_id: `pcc_${stableHash(candidateBody).slice(7)}` };
  const parsed = projectContentCandidateSchema.safeParse(candidate);
  if (!parsed.success) return fail("PLAN_DECISION_CANDIDATE_INVALID");
  return deepFreeze({ created: true, candidate: parsed.data, delivery: "pending_only" });
}

function snap<T>(input: unknown): T {
  try {
    return snapshotData(input) as T;
  } catch {
    return fail("PLAN_DECISION_INPUT_INVALID");
  }
}

function evaluateDecisionGraph(input: DecisionGraphInput): DecisionGraph {
  return evaluateDecisionGraphCanonical(snap<DecisionGraphInput>(input));
}

function buildApprovalPackage(input: ApprovalPackageInput): ApprovalPackage {
  return canonicalApprovalPackage(snap<ApprovalPackageInput>(input));
}

function recordApproval(input: Parameters<PlanDecisionModule["recordApproval"]>[0]): ApprovalDecisionResult {
  return recordApprovalCanonical(snap<Parameters<PlanDecisionModule["recordApproval"]>[0]>(input));
}

function verifyApprovalReceipt(input: Parameters<PlanDecisionModule["verifyApprovalReceipt"]>[0]) {
  try {
    return verifyApprovalReceiptCanonical(snapshotData(input) as Parameters<PlanDecisionModule["verifyApprovalReceipt"]>[0]);
  } catch {
    return deepFreeze({ valid: false, reason_code: "APPROVAL_RECEIPT_INVALID" as const,
      approved_design_document: null });
  }
}

function createArchitectureDecisionCandidate(input: ArchitectureDecisionCandidateInput): ProjectCandidateResult {
  return createArchitectureDecisionCandidateCanonical(snap<ArchitectureDecisionCandidateInput>(input));
}

function normalizeApprovalPackage(input: unknown, trusted: ApprovalPackageInput): ApprovalPackageReadResult {
  try {
    const record = snapshotData(input);
    if (!plainRecord(record) || typeof record.schema_version !== "number") {
      return deepFreeze({ ok: false, reason_code: "APPROVAL_PACKAGE_RECORD_INVALID" as const });
    }
    if (record.schema_version === 0) {
      return exact(record, ["schema_version", "legacy_ref"]) && boundedText(record.legacy_ref, 256) ?
        deepFreeze({ ok: true, source_schema_version: 0 as const, readiness: "legacy_read_only" as const,
          legacy_ref: record.legacy_ref }) :
        deepFreeze({ ok: false, reason_code: "APPROVAL_PACKAGE_RECORD_INVALID" as const });
    }
    if (record.schema_version !== 1) {
      return deepFreeze({ ok: false, reason_code: "APPROVAL_PACKAGE_VERSION_UNSUPPORTED" as const });
    }
    if (!packageValid(record)) {
      return deepFreeze({ ok: false, reason_code: "APPROVAL_PACKAGE_RECORD_INVALID" as const });
    }
    const trustedInput = snapshotData(trusted) as ApprovalPackageInput;
    const expected = canonicalApprovalPackage(trustedInput);
    if (stableHash(expected) !== stableHash(record)) {
      return deepFreeze({ ok: false, reason_code: "APPROVAL_PACKAGE_RECORD_INVALID" as const });
    }
    return deepFreeze({ ok: true, source_schema_version: 1 as const, readiness: "current" as const,
      package: deepFreeze(record) });
  } catch {
    return deepFreeze({ ok: false, reason_code: "APPROVAL_PACKAGE_RECORD_INVALID" as const });
  }
}

export function createPlanDecisionModule(): PlanDecisionModule {
  return deepFreeze({
    evaluateDecisionGraph,
    buildApprovalPackage,
    recordApproval,
    verifyApprovalReceipt,
    createArchitectureDecisionCandidate,
    normalizeApprovalPackage,
    normalizeRecord(input, trusted) {
      try {
        const record = snapshotData(input);
        if (!plainRecord(record) || typeof record.schema_version !== "number") {
          return deepFreeze({ ok: false, reason_code: "PLAN_DECISION_RECORD_INVALID" });
        }
        if (record.schema_version === 1) {
          if (trusted === undefined) return deepFreeze({ ok: false, reason_code: "PLAN_DECISION_RECORD_INVALID" });
          const trustedInput = snapshotData(trusted) as NonNullable<typeof trusted>;
          if (!isDecisionGraph(record)) return deepFreeze({ ok: false, reason_code: "PLAN_DECISION_RECORD_INVALID" });
          const expected = evaluateDecisionGraphCanonical({ schema_version: 1, ...trustedInput,
            nodes: record.nodes, evaluated_at: record.evaluated_at });
          if (stableHash(expected) !== stableHash(record)) {
            return deepFreeze({ ok: false, reason_code: "PLAN_DECISION_RECORD_INVALID" });
          }
          return deepFreeze({ ok: true, source_schema_version: 1, readiness: "current", graph: deepFreeze(record) });
        }
        if (record.schema_version === 0 && exact(record, ["schema_version", "legacy_ref"]) && boundedText(record.legacy_ref, 256)) {
          return deepFreeze({ ok: true, source_schema_version: 0, readiness: "legacy_read_only", legacy_ref: record.legacy_ref });
        }
        return deepFreeze({ ok: false, reason_code: record.schema_version === 1 ?
          "PLAN_DECISION_RECORD_INVALID" : "PLAN_DECISION_VERSION_UNSUPPORTED" });
      } catch {
        return deepFreeze({ ok: false, reason_code: "PLAN_DECISION_RECORD_INVALID" });
      }
    }
  });
}
