import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runPlanEvidencePack } from "../src/commands/plan-evidence-pack.js";

/**
 * `--print-template` 是 agent 发现 v2 自然输入结构的唯一入口（skill 明令禁止翻 TS 接口
 * 与 npx 缓存）。骨架一旦与冻结校验器漂移，调用方拿到的就是"必定失败的样例"，只能去
 * 反编译 dist bundle 找契约。本文件把模板绑定到真实命令上：模板不改一个字必须跑通。
 */

interface Envelope {
  readonly code: string;
  readonly stage: string;
  readonly field_path?: string;
  readonly problems?: readonly {
    readonly field_path: string;
    readonly missing_keys?: readonly string[];
    readonly unexpected_keys?: readonly string[];
    readonly message?: string;
  }[];
}

describe("hunter-harness plan evidence-pack 自然输入边界", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "harness-pack-template-"));
    await fs.mkdir(join(root, ".harness", "changes"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const deps = (outputs: string[]) => ({
    cwd: root,
    stdout: (chunk: string) => { outputs.push(chunk); return true; },
    stderr: () => true
  });

  async function template(): Promise<Record<string, unknown>> {
    const out: string[] = [];
    const exit = await runPlanEvidencePack(
      { input: "", output: "", printTemplate: true }, deps(out));
    expect(exit).toBe(0);
    return JSON.parse(out.join("")) as Record<string, unknown>;
  }

  async function pack(input: unknown): Promise<{ exit: number; body: Envelope }> {
    const inputPath = join(root, `input-${Math.random().toString(36).slice(2)}.json`);
    await fs.writeFile(inputPath, JSON.stringify(input));
    const out: string[] = [];
    const exit = await runPlanEvidencePack(
      { input: inputPath, output: join(root, "evidence.json") }, deps(out));
    return { exit, body: JSON.parse(out.join("")) as Envelope };
  }

  it("--print-template 的骨架不改一个字就能通过 evidence-pack", async () => {
    const { exit, body } = await pack(await template());
    if (exit !== 0) console.error("PACK-OUT:", JSON.stringify(body));
    expect(exit).toBe(0);
    expect(body.code).toBe("PLAN_EVIDENCE_PACK_BUILT");
  });

  it("evidence_sources 用非契约键时报出字段路径与缺失/多余键", async () => {
    const input = await template();
    input.evidence_sources = [{ kind: "code", ref: "src/a.ts", note: "结论" }];

    const { exit, body } = await pack(input);

    expect(exit).toBe(1);
    expect(body.code).toBe("PLAN_EVIDENCE_INPUT_INVALID");
    expect(body.stage).toBe("boundary");
    expect(body.field_path).toBe("evidence_sources[0]");
    expect(body.problems?.[0]?.missing_keys).toContain("source_kind");
    expect(body.problems?.[0]?.unexpected_keys).toContain("kind");
  });

  it("tasks 缺 objective/affected_paths 时报出字段路径", async () => {
    const input = await template();
    (input.structured_input as Record<string, unknown>).tasks = [
      { task_id: "T1", cluster: "簇", title: "任务", owner_phase: "execute" }
    ];

    const { exit, body } = await pack(input);

    expect(exit).toBe(1);
    expect(body.code).toBe("PLAN_EVIDENCE_INPUT_INVALID");
    expect(body.field_path).toBe("structured_input.tasks[0]");
    expect(body.problems?.[0]?.missing_keys).toEqual(
      expect.arrayContaining(["objective", "affected_paths"]));
    expect(body.problems?.[0]?.unexpected_keys).toEqual(
      expect.arrayContaining(["cluster", "title"]));
  });

  it("scenarios 缺 acceptance/execution_level 等必需键时报出字段路径", async () => {
    const input = await template();
    const structured = input.structured_input as { scenarios: Record<string, unknown>[] };
    structured.scenarios[0] = {
      scenario_id: "UT-001", title: "场景", coverage_dimension: "normal_path",
      priority: "P0", severity: "blocker"
    };

    const { exit, body } = await pack(input);

    expect(exit).toBe(1);
    expect(body.code).toBe("PLAN_EVIDENCE_INPUT_INVALID");
    expect(body.field_path).toBe("structured_input.scenarios[0]");
    expect(body.problems?.[0]?.missing_keys).toEqual(expect.arrayContaining(
      ["acceptance", "execution_level", "evidence_requirements", "risk_level", "owner_phase"]));
    // priority 现在是门禁消费的合法字段（P0/P1 决定哪些场景必须带 ledger 证据），
    // 不再是多余键；severity 才是。
    expect(body.problems?.[0]?.unexpected_keys).toContain("severity");
    expect(body.problems?.[0]?.unexpected_keys).not.toContain("priority");
  });

  it("worktree_policy 取非枚举值时报出字段路径与合法取值", async () => {
    const input = await template();
    (input.machine as Record<string, unknown>).worktree_policy = "none";

    const { exit, body } = await pack(input);

    expect(exit).toBe(1);
    expect(body.code).toBe("PLAN_EVIDENCE_INPUT_INVALID");
    expect(body.field_path).toBe("machine.worktree_policy");
    expect(body.problems?.[0]?.message).toContain("project_default");
  });

  it("场景少于 3 条时在边界报出下限，而不是等冻结模块抛通用码", async () => {
    const input = await template();
    const structured = input.structured_input as { scenarios: Record<string, unknown>[] };
    structured.scenarios = structured.scenarios.slice(0, 1);

    const { exit, body } = await pack(input);

    expect(exit).toBe(1);
    expect(body.code).toBe("PLAN_EVIDENCE_INPUT_INVALID");
    expect(body.field_path).toBe("structured_input.scenarios");
    expect(body.problems?.[0]?.message).toContain("3");
  });

  it("content_hash 用全 0 占位时在边界报出，而不是等冻结模块抛通用码", async () => {
    const input = await template();
    const sources = input.evidence_sources as Record<string, unknown>[];
    sources[0].content_hash = `sha256:${"0".repeat(64)}`;

    const { exit, body } = await pack(input);

    expect(exit).toBe(1);
    expect(body.code).toBe("PLAN_EVIDENCE_INPUT_INVALID");
    expect(body.field_path).toBe("evidence_sources[0].content_hash");
  });

  it("coverage_dimension 取非八维度值时报出字段路径", async () => {
    const input = await template();
    const scenarios = (input.structured_input as { scenarios: Record<string, unknown>[] }).scenarios;
    scenarios[0].coverage_dimension = "happy_path";

    const { exit, body } = await pack(input);

    expect(exit).toBe(1);
    expect(body.code).toBe("PLAN_EVIDENCE_INPUT_INVALID");
    expect(body.field_path).toBe("structured_input.scenarios[0].coverage_dimension");
    expect(body.problems?.[0]?.message).toContain("normal_path");
  });

  it("affected_paths 用目录路径时报出字段路径与写法说明（P1-3）", async () => {
    const input = await template();
    const structured = input.structured_input as { tasks: Record<string, unknown>[] };
    structured.tasks[0].affected_paths = ["src/main/java/com/klerp/salesinsight/"];

    const { exit, body } = await pack(input);

    expect(exit).toBe(1);
    expect(body.code).toBe("PLAN_EVIDENCE_INPUT_INVALID");
    expect(body.stage).toBe("boundary");
    expect(body.field_path).toBe("structured_input.tasks[0].affected_paths[0]");
    expect(body.problems?.[0]?.message).toContain("相对文件路径");
    // 不再是冻结模块的无定位 PLAN_ARTIFACT_INPUT_INVALID
    expect(JSON.stringify(body)).not.toContain("PLAN_ARTIFACT_INPUT_INVALID");
  });

  it("uncertainties 非空但 decision_nodes 未覆盖时报出期望决策 id（P1-1）", async () => {
    const input = await template();
    (input.intent as Record<string, unknown>).uncertainties = ["缓存策略待确认"];

    const { exit, body } = await pack(input);

    expect(exit).toBe(1);
    expect(body.code).toBe("PLAN_EVIDENCE_INPUT_INVALID");
    expect(body.field_path).toBe("intent.uncertainties");
    expect(body.problems?.[0]?.message).toContain("intent_uncertainty:");
    // 不再是冻结模块的无定位 PLAN_DECISION_INPUT_INVALID
    expect(JSON.stringify(body)).not.toContain("PLAN_DECISION_INPUT_INVALID");
  });

  it("uncertainties 配上对应 decision node 后整链路通过（P1-1）", async () => {
    const input = await template();
    const uncertainty = "缓存策略待确认";
    (input.intent as Record<string, unknown>).uncertainties = [uncertainty];
    const expectedId = `intent_uncertainty:${createHash("sha256")
      .update(JSON.stringify(uncertainty), "utf8").digest("hex")}`;
    input.decision_nodes = [{
      schema_version: 1,
      decision_id: expectedId,
      decision_version: 1,
      type: "product_decision",
      depends_on: [],
      status: "resolved",
      resolution: "采用本地缓存",
      resolved_by: "user",
      resolved_at: "2026-08-30T00:00:00.000Z",
      tradeoffs: [],
      affected_behaviors: [],
      evidence_refs: []
    }];

    const { exit, body } = await pack(input);

    if (exit !== 0) console.error("PACK-OUT:", JSON.stringify(body));
    expect(exit).toBe(0);
    expect(body.code).toBe("PLAN_EVIDENCE_PACK_BUILT");
  });

  it("approval.content 缺 in_scope/out_of_scope 时从 intent 继承（P1-4）", async () => {
    const input = await template();
    const content = (input.approval as { content: Record<string, unknown> }).content;
    delete content.in_scope;
    delete content.out_of_scope;

    const { exit, body } = await pack(input);

    if (exit !== 0) console.error("PACK-OUT:", JSON.stringify(body));
    expect(exit).toBe(0);
    expect((body as unknown as { warnings?: string[] }).warnings)
      .toContain("approval_scope_inherited:in_scope,out_of_scope");
  });

  it("approval.content.acceptance_examples 少于 3 条时在边界报出（P0-2）", async () => {
    const input = await template();
    const content = (input.approval as { content: Record<string, unknown> }).content;
    content.acceptance_examples = ["验收例子 1", "验收例子 2"];

    const { exit, body } = await pack(input);

    expect(exit).toBe(1);
    expect(body.code).toBe("PLAN_EVIDENCE_INPUT_INVALID");
    expect(body.field_path).toBe("approval.content.acceptance_examples");
    expect(body.problems?.[0]?.message).toContain("3~7");
  });

  it("decision_nodes 的枚举/键集错误在边界报出字段路径（P0-2）", async () => {
    const input = await template();
    input.decision_nodes = [{
      schema_version: 1,
      decision_id: "d1",
      decision_version: 1,
      type: "gut_feeling",
      depends_on: [],
      status: "resolved",
      tradeoffs: [],
      affected_behaviors: [],
      evidence_refs: []
    }];

    const { exit, body } = await pack(input);

    expect(exit).toBe(1);
    expect(body.code).toBe("PLAN_EVIDENCE_INPUT_INVALID");
    const paths = (body.problems ?? []).map((problem) => problem.field_path);
    expect(paths).toContain("decision_nodes[0].type");
    // status=resolved 缺三元的定位也在
    expect(body.problems?.some((problem) =>
      problem.missing_keys?.includes("resolution"))).toBe(true);
  });

  it("adversarial_review 透传进证据包（P0-1）", async () => {
    const input = await template();
    input.adversarial_review = {
      schema_version: 1,
      reviewer_identity: "inline:test-reviewer",
      review_mode: "inline",
      input_hash: `sha256:${"a".repeat(64)}`,
      findings_hash: `sha256:${"b".repeat(64)}`,
      findings: [],
      completed_at: "2026-08-30T00:00:00.000Z"
    };

    const inputPath = join(root, "input-with-review.json");
    const packPath = join(root, "evidence-with-review.json");
    await fs.writeFile(inputPath, JSON.stringify(input));
    const out: string[] = [];
    const exit = await runPlanEvidencePack(
      { input: inputPath, output: packPath }, deps(out));

    if (exit !== 0) console.error("PACK-OUT:", out.join(""));
    expect(exit).toBe(0);
    const built = JSON.parse(await fs.readFile(packPath, "utf8")) as Record<string, unknown>;
    expect(built.adversarial_review).toEqual(input.adversarial_review);
  });

  it("adversarial_review 形状不合法时在边界报出字段路径（P0-1）", async () => {
    const input = await template();
    input.adversarial_review = {
      schema_version: 1,
      reviewer_identity: "Bad Identity!",
      review_mode: "remote",
      input_hash: "not-a-hash"
    };

    const { exit, body } = await pack(input);

    expect(exit).toBe(1);
    expect(body.code).toBe("PLAN_EVIDENCE_INPUT_INVALID");
    const paths = (body.problems ?? []).map((problem) => problem.field_path);
    expect(paths).toContain("adversarial_review.reviewer_identity");
    expect(paths).toContain("adversarial_review.review_mode");
    expect(paths).toContain("adversarial_review.input_hash");
  });
});
