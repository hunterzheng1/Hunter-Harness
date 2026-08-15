import { createHash } from "node:crypto";
import type { DecisionGraph, DecisionQuestion, DecisionNode } from "@hunter-harness/core";
import { isProxy } from "node:util/types";

export type DecisionInteractionGraph = Pick<DecisionGraph,
  "schema_version" | "graph_id" | "input_hash" | "planning_context_ref" |
  "plan_profile_ref" | "planned_phase_set_ref" | "nodes" | "frontier_round" |
  "current_frontier" | "unresolved_decision_ids" | "blocked_decision_ids" |
  "question_budget" | "status" | "reason_codes" | "evaluated_at">;

export interface PresentedDecisionQuestion extends DecisionQuestion {
  readonly ordinal: number;
}

export interface DecisionInteractionBatch {
  readonly schema_version: 1;
  readonly batch_id: string;
  readonly graph_id: string;
  readonly input_hash: string;
  readonly frontier_round: number;
  readonly questions: readonly PresentedDecisionQuestion[];
}

export interface DecisionFrontierPresentation {
  readonly schema_version: 1;
  readonly batch: DecisionInteractionBatch;
  readonly questions: readonly PresentedDecisionQuestion[];
}

export interface DecisionAnswer {
  readonly decision_id: string;
  readonly decision_version: number;
  readonly answer: string;
}

export interface DecisionAnswerIntent {
  readonly schema_version: 1;
  readonly status: "completed" | "abandoned";
  readonly batch_id: string;
  readonly graph_id: string;
  readonly input_hash: string;
  readonly answers: readonly DecisionAnswer[];
}

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function canonicalText(value: unknown): string {
  return JSON.stringify(value, (_key, child) => {
    if (child === undefined) return undefined;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      return Object.fromEntries(Object.entries(child)
        .sort(([left], [right]) => compareCodepoint(left, right)));
    }
    return child;
  });
}

function sha256(value: unknown): string {
  const text = canonicalText(value);
  return `presentation:${createHash("sha256").update(text).digest("hex")}`;
}

export function decisionGraphIdentity(graph: DecisionInteractionGraph): string {
  let snapshot: DecisionInteractionGraph;
  try {
    snapshot = deepSnapshot(graph) as DecisionInteractionGraph;
  } catch {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  const body = Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "graph_id"));
  return `decision_graph:${sha256(body).slice("presentation:".length)}`;
}

function deepSnapshot(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  budget.nodes += 1;
  if (value === null) return null;
  const primitiveType = typeof value;
  if (primitiveType !== "object") {
    if (primitiveType === "string" || primitiveType === "boolean" ||
        (primitiveType === "number" && Number.isFinite(value))) return value;
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  if (depth > 24 || budget.nodes > 8192 || isProxy(value)) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  if (Array.isArray(value)) {
    const length = descriptors.length;
    if (length === undefined || !("value" in length) || typeof length.value !== "number" ||
        !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 256 || keys.length !== length.value + 1) {
      throw new Error("PLAN_INTERACTION_INPUT_INVALID");
    }
    const array = new Array<unknown>(length.value);
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("PLAN_INTERACTION_INPUT_INVALID");
      }
      array[index] = deepSnapshot(descriptor.value, depth + 1, budget);
    }
    return Object.freeze(array);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("PLAN_INTERACTION_INPUT_INVALID");
    }
    result[key] = deepSnapshot(descriptor.value, depth + 1, budget);
  }
  return Object.freeze(result);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isIdentity(value: unknown, prefix: string): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}:[a-f0-9]{64}$`, "u").test(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validStringArray(value: unknown, maximum: number, itemMaximum: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maximum &&
    value.every((item) => typeof item === "string" && item.length > 0 && item.length <= itemMaximum);
}

function exactKeys(value: object, required: readonly string[], optional: readonly string[] = []): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = new Set([...required, ...optional]);
  return keys.length >= required.length && keys.every((key) =>
    typeof key === "string" && allowed.has(key)) && required.every((key) => {
    const descriptor = descriptors[key];
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function canonicalSortedUnique(value: readonly string[]): boolean {
  return new Set(value).size === value.length &&
    JSON.stringify(value) === JSON.stringify([...value].sort(compareCodepoint));
}

function boundedCanonicalText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && value === value.normalize("NFC") &&
    ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 31 ||
      (character.codePointAt(0) ?? 0) === 127);
}

function validQuestion(question: unknown): question is PresentedDecisionQuestion {
  if (question === null || typeof question !== "object" || isProxy(question)) return false;
  const value = question as Record<string, unknown>;
  return exactKeys(value, ["decision_id", "decision_version", "question", "recommendation",
    "recommendation_reason", "tradeoffs", "affected_behaviors", "ordinal"]) &&
    boundedCanonicalText(value.decision_id, 160) &&
    Number.isSafeInteger(value.decision_version) && (value.decision_version as number) >= 1 &&
    boundedCanonicalText(value.question, 2048) &&
    boundedCanonicalText(value.recommendation, 2048) &&
    boundedCanonicalText(value.recommendation_reason, 2048) && Array.isArray(value.tradeoffs) && value.tradeoffs.length >= 1 &&
    value.tradeoffs.length <= 16 && value.tradeoffs.every((item) => boundedCanonicalText(item, 2048)) &&
    Array.isArray(value.affected_behaviors) && value.affected_behaviors.length >= 1 && value.affected_behaviors.length <= 32 &&
    value.affected_behaviors.every((item) => boundedCanonicalText(item, 256)) &&
    Number.isSafeInteger(value.ordinal) && (value.ordinal as number) >= 0;
}

function validatePresentation(value: unknown): DecisionFrontierPresentation {
  let snapshot: DecisionFrontierPresentation;
  try { snapshot = deepSnapshot(value) as DecisionFrontierPresentation; } catch {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  if (snapshot === null || typeof snapshot !== "object" || snapshot.schema_version !== 1 ||
      snapshot.batch === null || typeof snapshot.batch !== "object" || isProxy(snapshot.batch) ||
      !exactKeys(snapshot, ["schema_version", "batch", "questions"]) ||
      !exactKeys(snapshot.batch, ["schema_version", "batch_id", "graph_id", "input_hash", "frontier_round", "questions"]) ||
      snapshot.batch.schema_version !== 1 || !isIdentity(snapshot.batch.graph_id, "decision_graph") ||
      !isSha(snapshot.batch.input_hash) || !Number.isSafeInteger(snapshot.batch.frontier_round) ||
      snapshot.batch.frontier_round < 1 || !Array.isArray(snapshot.questions) || snapshot.questions.length > 3 ||
      !Array.isArray(snapshot.batch.questions) || snapshot.batch.questions.length !== snapshot.questions.length ||
      !snapshot.questions.every(validQuestion) || !snapshot.batch.questions.every(validQuestion) ||
      snapshot.questions.some((question, index) => canonicalText(question) !== canonicalText(snapshot.batch.questions[index]))) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  const questionIds = snapshot.questions.map((question) => question.decision_id);
  if (new Set(questionIds).size !== questionIds.length ||
      JSON.stringify(questionIds) !== JSON.stringify([...questionIds].sort(compareCodepoint))) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  const batchBody = {
    schema_version: 1 as const,
    graph_id: snapshot.batch.graph_id,
    input_hash: snapshot.batch.input_hash,
    frontier_round: snapshot.batch.frontier_round,
    questions: snapshot.batch.questions,
  };
  const expectedBatchId = `decision_interaction_batch:${sha256(batchBody).slice("presentation:".length)}`;
  if (snapshot.batch.batch_id !== expectedBatchId ||
      snapshot.questions.some((question, index) => question.ordinal !== index)) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  return snapshot;
}

function validateGraph(graph: DecisionInteractionGraph): void {
  if (graph.schema_version !== 1 || !isIdentity(graph.graph_id, "decision_graph") ||
      graph.graph_id !== decisionGraphIdentity(graph) || !isSha(graph.input_hash) ||
      !isIdentity(graph.planning_context_ref, "planning_context") || !isIdentity(graph.plan_profile_ref, "plan_profile") ||
      !isIdentity(graph.planned_phase_set_ref, "planned_phase_set") || !Number.isSafeInteger(graph.frontier_round) ||
      graph.frontier_round < 0 || !Array.isArray(graph.nodes) || graph.nodes.length > 64 ||
      !Array.isArray(graph.current_frontier) || graph.current_frontier.length > 3 ||
      !Array.isArray(graph.unresolved_decision_ids) || !Array.isArray(graph.blocked_decision_ids) ||
      !Array.isArray(graph.reason_codes) || graph.question_budget === null ||
      typeof graph.question_budget !== "object") {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  if (!exactKeys(graph, ["schema_version", "graph_id", "input_hash", "planning_context_ref", "plan_profile_ref",
    "planned_phase_set_ref", "nodes", "frontier_round", "current_frontier", "unresolved_decision_ids",
    "blocked_decision_ids", "question_budget", "status", "reason_codes", "evaluated_at"]) ||
      !validTimestamp(graph.evaluated_at) || !exactKeys(graph.question_budget, ["minimum", "maximum", "used", "remaining"])) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  const nodes = graph.nodes as readonly DecisionNode[];
  if (nodes.some((node) => node === null || typeof node !== "object" || Array.isArray(node))) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  if (!validStringArray(graph.unresolved_decision_ids, 64, 160) ||
      !validStringArray(graph.blocked_decision_ids, 64, 160) ||
      !validStringArray(graph.reason_codes, 16, 128) ||
      !canonicalSortedUnique(graph.unresolved_decision_ids) ||
      !canonicalSortedUnique(graph.blocked_decision_ids)) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  const ids = nodes.map((node) => node.decision_id);
  if (ids.some((id) => !boundedCanonicalText(id, 160))) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  const nodeTypes = new Set(["fact", "engineering_default", "product_decision", "risk_decision"]);
  const nodeStatuses = new Set(["pending", "resolved", "blocked", "superseded"]);
  const nodeById = new Map(nodes.map((node) => [node.decision_id, node]));
  if (new Set(ids).size !== ids.length || !canonicalSortedUnique(ids) ||
      ids.some((id) => !nodes.some((node) => node.decision_id === id)) ||
      nodes.some((node) => {
        const expectedResolver = node.type === "fact" ? "evidence" :
          node.type === "engineering_default" ? "engineering_default" : "user";
        const affected = Array.isArray(node.affected_behaviors) ? node.affected_behaviors : [];
        const evidenceRefs = Array.isArray(node.evidence_refs) ? node.evidence_refs : [];
        const factEvidenceShape = node.type !== "fact" ||
          (node.status === "resolved" && evidenceRefs.length > 0);
        const defaultShape = node.type !== "engineering_default" ||
          (typeof node.recommendation === "string" && node.recommendation.length > 0 &&
            typeof node.recommendation_reason === "string" && node.recommendation_reason.length > 0);
        const resolvedShape = node.status === "resolved" &&
          boundedCanonicalText(node.resolution, 2048) &&
          node.resolved_by === expectedResolver && validTimestamp(node.resolved_at);
        const nonResolvedShape = node.status !== "resolved" &&
          node.resolution === undefined && node.resolved_by === undefined && node.resolved_at === undefined;
        const nonResolvedRoleShape = nonResolvedShape &&
          !((node.type === "fact" || node.type === "engineering_default") && node.status === "pending") &&
          !((node.type === "product_decision" || node.type === "risk_decision") && node.status === "blocked") &&
          !(node.status === "superseded" &&
            (affected.length === 0 ||
              !affected.every((behavior) => ["worktree", "planned_phases", "agent_selection", "change_name", "coverage"].includes(behavior))));
        const roleShape = node.status === "resolved"
          ? resolvedShape && factEvidenceShape && defaultShape
          : nonResolvedRoleShape;
        if (!exactKeys(node, ["schema_version", "decision_id", "decision_version", "type", "depends_on", "status",
          "tradeoffs", "affected_behaviors", "evidence_refs"],
          ["question", "recommendation", "recommendation_reason", "resolution", "resolved_by", "resolved_at"]) ||
            node.schema_version !== 1 || !nodeTypes.has(node.type) || !nodeStatuses.has(node.status) ||
            !Number.isSafeInteger(node.decision_version) || node.decision_version < 1 ||
            !Array.isArray(node.depends_on) || node.depends_on.length > 64 ||
            node.depends_on.some((id) => !boundedCanonicalText(id, 160) || !ids.includes(id)) ||
            JSON.stringify(node.depends_on) !== JSON.stringify([...node.depends_on].sort(compareCodepoint)) ||
            new Set(node.depends_on).size !== node.depends_on.length || !Array.isArray(node.tradeoffs) ||
            node.tradeoffs.length > 16 || node.tradeoffs.some((item) => !boundedCanonicalText(item, 2048)) ||
            !Array.isArray(node.affected_behaviors) || node.affected_behaviors.length > 32 ||
            node.affected_behaviors.some((item) => !boundedCanonicalText(item, 256)) ||
            !Array.isArray(node.evidence_refs) || node.evidence_refs.length > 64 ||
            node.evidence_refs.some((item) => !boundedCanonicalText(item, 512)) ||
            !canonicalSortedUnique(node.depends_on) || !canonicalSortedUnique(node.evidence_refs) ||
            (node.status === "resolved" && (typeof node.resolution !== "string" || typeof node.resolved_by !== "string" ||
              typeof node.resolved_at !== "string")) ||
            (node.status !== "resolved" && (node.resolution !== undefined || node.resolved_by !== undefined ||
              node.resolved_at !== undefined)) || !roleShape) return true;
        for (const key of ["question", "recommendation", "recommendation_reason"] as const) {
          if (node[key] !== undefined && !boundedCanonicalText(node[key], 2048)) return true;
        }
        return false;
      })) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    const node = nodeById.get(id);
    if (node === undefined) return true;
    visiting.add(id);
    const result = node.depends_on.some((dependency) => cyclic(dependency));
    visiting.delete(id);
    visited.add(id);
    return result;
  };
  if (ids.some(cyclic)) throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  const resolved = new Set(nodes.filter((node) => node.status === "resolved" || node.status === "superseded")
    .map((node) => node.decision_id));
  const eligible = nodes.filter((node) =>
    (node.type === "product_decision" || node.type === "risk_decision") && node.status === "pending" &&
    node.depends_on.every((id) => resolved.has(id)))
    .sort((left, right) => compareCodepoint(left.decision_id, right.decision_id));
  const levels = new Map<string, number>();
  const level = (id: string, visiting: ReadonlySet<string> = new Set()): number => {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return Number.POSITIVE_INFINITY;
    const node = nodeById.get(id);
    if (node === undefined) return Number.POSITIVE_INFINITY;
    const next = new Set(visiting);
    next.add(id);
    const result = node.depends_on.length === 0 ? 1 :
      1 + Math.max(...node.depends_on.map((dependency) => level(dependency, next)));
    levels.set(id, result);
    return result;
  };
  if (nodes.some((node) => !Number.isFinite(level(node.decision_id)))) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  const budget = graph.question_budget as Record<string, unknown>;
  const policy = budget.minimum === 0 && budget.maximum === 1 ? 1 : budget.minimum === 1 && budget.maximum === 3 ? 3 :
    budget.minimum === 5 && budget.maximum === 7 ? 3 : 0;
  const used = nodes.filter((node) => (node.type === "product_decision" || node.type === "risk_decision") &&
    node.status === "resolved" && node.resolved_by === "user").length;
  if (policy === 0 || !Number.isSafeInteger(budget.minimum) || !Number.isSafeInteger(budget.maximum) ||
      !Number.isSafeInteger(budget.used) || !Number.isSafeInteger(budget.remaining) || budget.used !== used ||
      budget.remaining !== (budget.maximum as number) - (budget.used as number) || (budget.used as number) < 0 ||
      (budget.used as number) > (budget.maximum as number)) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  for (const question of graph.current_frontier) {
    if (question === null || typeof question !== "object" || isProxy(question) ||
        !exactKeys(question, ["decision_id", "decision_version", "question", "recommendation",
          "recommendation_reason", "tradeoffs", "affected_behaviors"]) ||
        typeof question.decision_id !== "string" || question.decision_id.length === 0 ||
        !Number.isSafeInteger(question.decision_version) || question.decision_version < 1 ||
        typeof question.question !== "string" || question.question.length === 0 || question.question.length > 2048 ||
        typeof question.recommendation !== "string" || question.recommendation.length === 0 || question.recommendation.length > 2048 ||
        typeof question.recommendation_reason !== "string" || question.recommendation_reason.length === 0 ||
        question.recommendation_reason.length > 2048 || !Array.isArray(question.tradeoffs) ||
        question.tradeoffs.length < 1 || question.tradeoffs.length > 16 ||
        question.tradeoffs.some((item: unknown) => typeof item !== "string" || item.length === 0 || item.length > 2048) ||
        !Array.isArray(question.affected_behaviors) || question.affected_behaviors.length < 1 ||
        question.affected_behaviors.length > 32 ||
        question.affected_behaviors.some((item: unknown) => typeof item !== "string" || item.length === 0 || item.length > 256)) {
      throw new Error("PLAN_INTERACTION_INPUT_INVALID");
    }
    const node = nodeById.get(question.decision_id);
    if (node === undefined || node.status !== "pending" || node.decision_version !== question.decision_version ||
        node.question !== question.question || node.recommendation !== question.recommendation ||
        node.recommendation_reason !== question.recommendation_reason ||
        canonicalText(node.tradeoffs) !== canonicalText(question.tradeoffs) ||
        canonicalText(node.affected_behaviors) !== canonicalText(question.affected_behaviors)) {
      throw new Error("PLAN_INTERACTION_INPUT_INVALID");
    }
  }
  const actual = graph.current_frontier.map((question) => question.decision_id).sort(compareCodepoint);
  const unresolved = nodes.filter((node) => node.status !== "resolved" && node.status !== "superseded")
    .map((node) => node.decision_id).sort(compareCodepoint);
  const blocked = nodes.filter((node) => (node.type === "fact" || node.type === "engineering_default") && node.status === "blocked")
    .map((node) => node.decision_id).sort(compareCodepoint);
  const invalidQuestions = eligible.filter((node) =>
    node.question === undefined || node.recommendation === undefined || node.recommendation_reason === undefined ||
    node.tradeoffs.length === 0 || node.affected_behaviors.length === 0);
  const wouldExceed = eligible.length > (budget.remaining as number) ||
    (eligible.length === 0 && unresolved.length > 0 && (budget.remaining as number) === 0);
  const structurallyInvalid = invalidQuestions.length > 0 || blocked.length > 0;
  const expectedFrontier = structurallyInvalid || wouldExceed ? [] :
    eligible.slice(0, Math.min(policy, budget.remaining as number));
  const expectedReasons = [
    ...(blocked.length > 0 ? ["evidence_or_default_missing"] : []),
    ...(invalidQuestions.length > 0 ? ["question_details_missing"] : []),
    ...(wouldExceed ? ["question_budget_exceeded"] : [])
  ];
  const expectedStatus = structurallyInvalid ? "not_publishable" : wouldExceed ? "paused" :
    unresolved.length === 0 ? "ready_for_approval" : expectedFrontier.length > 0 ?
      "questions_required" : "not_publishable";
  const expectedRound = expectedFrontier.length === 0 ? 0 :
    Math.min(...expectedFrontier.map((node) => level(node.decision_id)));
  if (graph.current_frontier.length === 0 || graph.status !== "questions_required" ||
      JSON.stringify(actual) !== JSON.stringify(expectedFrontier.map((node) => node.decision_id)) ||
      graph.status !== expectedStatus ||
      JSON.stringify([...graph.unresolved_decision_ids].sort(compareCodepoint)) !== JSON.stringify(unresolved) ||
      JSON.stringify([...graph.blocked_decision_ids].sort(compareCodepoint)) !== JSON.stringify(blocked) ||
      graph.current_frontier.length > policy || graph.frontier_round !== expectedRound ||
      JSON.stringify(graph.reason_codes) !== JSON.stringify(expectedReasons) ||
      new Set(graph.current_frontier.map((question) => question.decision_id)).size !== graph.current_frontier.length) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
}

export function presentDecisionFrontier(
  graph: DecisionInteractionGraph,
): DecisionFrontierPresentation {
  if (graph === null || typeof graph !== "object" || isProxy(graph)) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(graph);
  } catch {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  const required = [
    "schema_version", "graph_id", "input_hash", "planning_context_ref", "plan_profile_ref",
    "planned_phase_set_ref", "nodes", "frontier_round", "current_frontier",
    "unresolved_decision_ids", "blocked_decision_ids", "question_budget", "status",
    "reason_codes", "evaluated_at"
  ];
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string") || keys.length !== required.length ||
      required.some((key) => {
        const descriptor = descriptors[key];
        return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
      })) {
    throw new Error("PLAN_INTERACTION_INPUT_INVALID");
  }
  const snapshot = deepSnapshot(graph) as DecisionInteractionGraph;
  validateGraph(snapshot);
  const questions = [...snapshot.current_frontier]
    .sort((left, right) => compareCodepoint(left.decision_id, right.decision_id))
    .map((question, ordinal) => deepFreeze({ ...question, ordinal }));
  const batchBody = {
    schema_version: 1 as const,
    graph_id: snapshot.graph_id,
    input_hash: snapshot.input_hash,
    frontier_round: snapshot.frontier_round,
    questions,
  };
  const batch = deepFreeze({
    ...batchBody,
    batch_id: `decision_interaction_batch:${sha256(batchBody).slice("presentation:".length)}`,
  });
  return deepFreeze({ schema_version: 1 as const, batch, questions });
}

export async function collectDecisionAnswers(
  presentation: DecisionFrontierPresentation,
  ask: (question: PresentedDecisionQuestion) => Promise<string | null>,
): Promise<DecisionAnswerIntent> {
  const safePresentation = validatePresentation(presentation);
  const answers: DecisionAnswer[] = [];
  for (const question of safePresentation.questions) {
    const answer = await ask(question);
    if (answer === null) {
      return deepFreeze({
        schema_version: 1,
        status: "abandoned",
        batch_id: safePresentation.batch.batch_id,
        graph_id: safePresentation.batch.graph_id,
        input_hash: safePresentation.batch.input_hash,
        answers: [],
      });
    }
    if (typeof answer !== "string" || isProxy(answer) || answer.length === 0 || answer.length > 2048 || answer.trim() !== answer) {
      throw new Error("PLAN_INTERACTION_OUTPUT_INVALID");
    }
    answers.push(deepFreeze({
      decision_id: question.decision_id,
      decision_version: question.decision_version,
      answer: answer.trim(),
    }));
  }
  return deepFreeze({
    schema_version: 1,
    status: "completed",
    batch_id: safePresentation.batch.batch_id,
    graph_id: safePresentation.batch.graph_id,
    input_hash: safePresentation.batch.input_hash,
    answers,
  });
}
