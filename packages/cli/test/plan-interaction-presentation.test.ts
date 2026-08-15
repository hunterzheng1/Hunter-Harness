import { describe, expect, it } from "vitest";

import {
  collectDecisionAnswers,
  decisionGraphIdentity,
  presentDecisionFrontier,
  type DecisionInteractionGraph
} from "../src/plan-interaction-presentation/index.js";

function graph(): DecisionInteractionGraph {
  const value = {
    schema_version: 1,
    graph_id: "decision_graph:" + "0".repeat(64),
    input_hash: "sha256:" + "1".repeat(64),
    planning_context_ref: "planning_context:" + "b".repeat(64),
    plan_profile_ref: "plan_profile:" + "c".repeat(64),
    planned_phase_set_ref: "planned_phase_set:" + "d".repeat(64),
    nodes: [
      {
        schema_version: 1,
        decision_id: "decision:a",
        decision_version: 1,
        type: "product_decision",
        depends_on: [],
        status: "pending",
        question: "第一个问题？",
        recommendation: "方案 A",
        recommendation_reason: "因为 A 更简单。",
        tradeoffs: ["迁移成本"],
        affected_behaviors: ["存储路径"],
        evidence_refs: []
      },
      {
        schema_version: 1,
        decision_id: "decision:b",
        decision_version: 2,
        type: "product_decision",
        depends_on: [],
        status: "pending",
        question: "第二个问题？",
        recommendation: "方案 B",
        recommendation_reason: "因为 B 更稳妥。",
        tradeoffs: ["需要更多时间"],
        affected_behaviors: ["恢复路径"],
        evidence_refs: []
      }
    ],
    frontier_round: 1,
    current_frontier: [
      {
        decision_id: "decision:b",
        decision_version: 2,
        question: "第二个问题？",
        recommendation: "方案 B",
        recommendation_reason: "因为 B 更稳妥。",
        tradeoffs: ["需要更多时间"],
        affected_behaviors: ["恢复路径"]
      },
      {
        decision_id: "decision:a",
        decision_version: 1,
        question: "第一个问题？",
        recommendation: "方案 A",
        recommendation_reason: "因为 A 更简单。",
        tradeoffs: ["迁移成本"],
        affected_behaviors: ["存储路径"]
      }
    ],
    unresolved_decision_ids: ["decision:a", "decision:b"],
    blocked_decision_ids: [],
    question_budget: { minimum: 1, maximum: 3, used: 0, remaining: 3 },
    status: "questions_required",
    reason_codes: [],
    evaluated_at: "2026-08-14T00:00:00.000Z"
  } as DecisionInteractionGraph;
  value.graph_id = decisionGraphIdentity(value);
  return value;
}

describe("plan interaction presentation", () => {
  it("presents only the current frontier in deterministic order and collects a complete batch", async () => {
    const source = graph();
    const presentation = presentDecisionFrontier(source);

    expect(presentation.questions.map((question) => question.decision_id)).toEqual([
      "decision:a",
      "decision:b"
    ]);
    expect(presentation.batch.graph_id).toBe(source.graph_id);
    expect(presentation.questions[0]?.recommendation).toBe("方案 A");

    const asked: string[] = [];
    const intent = await collectDecisionAnswers(presentation, async (question) => {
      asked.push(question.decision_id);
      return question.decision_id === "decision:a" ? "接受 A" : "接受 B";
    });

    expect(asked).toEqual(["decision:a", "decision:b"]);
    expect(intent.status).toBe("completed");
    expect(intent.answers.map((answer) => answer.decision_id)).toEqual([
      "decision:a",
      "decision:b"
    ]);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.answers)).toBe(true);
    expect(source.current_frontier[0]?.question).toBe("第二个问题？");
  });

  it("abandons without partial answers when the user cancels", async () => {
    const presentation = presentDecisionFrontier(graph());
    let calls = 0;
    const intent = await collectDecisionAnswers(presentation, async () => {
      calls += 1;
      return null;
    });

    expect(calls).toBe(1);
    expect(intent.status).toBe("abandoned");
    expect(intent.answers).toEqual([]);
  });

  it("rejects hostile graph access without invoking getters", () => {
    let gets = 0;
    const hostile = new Proxy(graph(), {
      get() {
        gets += 1;
        throw new Error("getter executed");
      }
    });

    expect(() => presentDecisionFrontier(hostile)).toThrow("PLAN_INTERACTION_INPUT_INVALID");
    expect(gets).toBe(0);
  });

  it("rejects a chameleon frontier question before reading its getters", () => {
    let gets = 0;
    const question = new Proxy(graph().current_frontier[0] as object, {
      get() {
        gets += 1;
        throw new Error("question getter executed");
      }
    });
    const hostile = { ...graph(), current_frontier: [question] } as unknown as DecisionInteractionGraph;

    expect(() => presentDecisionFrontier(hostile)).toThrow("PLAN_INTERACTION_INPUT_INVALID");
    expect(gets).toBe(0);
  });

  it("rejects a forged graph identity and hostile answer without invoking getters", async () => {
    expect(() => presentDecisionFrontier({ ...graph(), graph_id: "foreign" })).toThrow(
      "PLAN_INTERACTION_INPUT_INVALID"
    );
    const presentation = presentDecisionFrontier(graph());
    let gets = 0;
    const hostileAnswer = Object.defineProperty({}, "trim", {
      get() { gets += 1; throw new Error("answer getter"); }
    });
    await expect(collectDecisionAnswers(presentation, async () => hostileAnswer as never))
      .rejects.toThrow("PLAN_INTERACTION_OUTPUT_INVALID");
    expect(gets).toBe(0);
  });

  it("rejects forged batch identity, oversized batches, and missing batch deterministically", async () => {
    const presentation = presentDecisionFrontier(graph());
    const forged = {
      ...presentation,
      batch: { ...presentation.batch, batch_id: "decision_interaction_batch:" + "0".repeat(64) }
    };
    await expect(collectDecisionAnswers(forged, async () => "ok"))
      .rejects.toThrow("PLAN_INTERACTION_INPUT_INVALID");

    const oversized = {
      ...presentation,
      questions: [...presentation.questions, ...presentation.questions],
      batch: {
        ...presentation.batch,
        questions: [...presentation.batch.questions, ...presentation.batch.questions]
      }
    };
    await expect(collectDecisionAnswers(oversized, async () => "ok"))
      .rejects.toThrow("PLAN_INTERACTION_INPUT_INVALID");
    await expect(collectDecisionAnswers({ questions: [] } as never, async () => "ok"))
      .rejects.toThrow("PLAN_INTERACTION_INPUT_INVALID");
  });

  it("rejects malformed nodes and semantically forged graph derivations", () => {
    const malformed = graph() as unknown as Record<string, unknown>;
    malformed.nodes = [null];
    expect(() => presentDecisionFrontier(malformed as DecisionInteractionGraph))
      .toThrow("PLAN_INTERACTION_INPUT_INVALID");

    const forged = graph();
    forged.frontier_round = 99;
    forged.reason_codes = ["question_budget_exceeded"];
    forged.status = "paused";
    forged.graph_id = decisionGraphIdentity(forged);
    expect(() => presentDecisionFrontier(forged)).toThrow("PLAN_INTERACTION_INPUT_INVALID");

    const malformedIds = graph() as unknown as Record<string, unknown>;
    malformedIds.unresolved_decision_ids = [{}];
    expect(() => presentDecisionFrontier(malformedIds as DecisionInteractionGraph))
      .toThrow("PLAN_INTERACTION_INPUT_INVALID");

    const invalidRole = graph() as unknown as Record<string, unknown>;
    invalidRole.nodes = [{
      ...(graph().nodes[0] as object),
      type: "fact",
      status: "pending"
    }, graph().nodes[1]];
    expect(() => presentDecisionFrontier(invalidRole as DecisionInteractionGraph))
      .toThrow("PLAN_INTERACTION_INPUT_INVALID");
  });

  it("rejects nested executable values without invoking them", () => {
    let calls = 0;
    const hostile = graph() as unknown as Record<string, unknown>;
    hostile.nodes = [{
      toJSON() {
        calls += 1;
        throw new Error("toJSON executed");
      }
    }];
    expect(() => decisionGraphIdentity(hostile as DecisionInteractionGraph))
      .toThrow("PLAN_INTERACTION_INPUT_INVALID");
    expect(calls).toBe(0);
  });

  it("rejects duplicate questions in a self-consistent forged presentation", async () => {
    const presentation = presentDecisionFrontier(graph());
    const duplicateQuestions = [presentation.questions[0], presentation.questions[0]];
    const forged = {
      schema_version: 1 as const,
      questions: duplicateQuestions,
      batch: {
        ...presentation.batch,
        questions: duplicateQuestions
      }
    };
    await expect(collectDecisionAnswers(forged as never, async () => "ok"))
      .rejects.toThrow("PLAN_INTERACTION_INPUT_INVALID");
  });
});
