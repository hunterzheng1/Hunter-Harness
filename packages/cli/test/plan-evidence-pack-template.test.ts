import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
