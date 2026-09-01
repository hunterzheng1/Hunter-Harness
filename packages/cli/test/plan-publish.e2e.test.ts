import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planDurablePublicationTargetPaths } from "@hunter-harness/core";

import { runPlanPublish } from "../src/commands/plan-publish.js";
import { runPlanReviewRecord } from "../src/commands/plan-review-record.js";

// 与 plan-evidence-pack e2e 同款 stub：tmpdir 不是 git 仓库
const stubGitExec = async (args: readonly string[]): Promise<string> => {
  const key = args.join(" ");
  if (key === "rev-parse --is-inside-work-tree") return "true\n";
  if (key === "remote") return "origin\n";
  if (key === "rev-parse --git-dir") return ".git\n";
  if (key === "rev-parse --git-common-dir") return ".git\n";
  if (key === "status --porcelain --untracked-files=all") return "";
  throw new Error(`unexpected git call: ${key}`);
};

const CHANGE_KEY = "publish-orch01";
const dimensions = ["business_rules", "concurrency_idempotency", "data_compatibility", "error_codes",
  "integration_impact", "normal_path", "parameter_validation", "permission_boundaries"] as const;

function naturalInput(options?: { assurance?: boolean; goal?: string }) {
  const goal = options?.goal ?? "编排收口端到端验证";
  const approvalContent = {
    goal,
    user_visible_outcome: "一条命令完成发布",
    in_scope: ["plan_publish"],
    out_of_scope: ["python_finalizer"],
    recommended_design: "编排收进 CLI，门禁语义不动",
    key_alternatives: ["继续三步手工链"],
    invariants: ["结构失败绝不发布"],
    failure_behaviors: ["任一步失败带步骤定位"],
    compatibility_boundaries: ["三步链保持可用"],
    risks: [{ risk: "续签误用", mitigation: "findings 未变才允许续签" }],
    acceptance_examples: ["首发成功", "重发布自动记账", "收据过期自动续签"]
  };
  const scenarios = dimensions.map((dimension, index) => ({
    scenario_id: `scenario:${dimension}`,
    title: `场景 ${dimension}`,
    acceptance: "发布证据闭合",
    coverage_dimension: dimension,
    execution_level: (index === 0 ? "unit" : "integration"),
    evidence_requirements: ["focused_test"],
    risk_level: options?.assurance === true && dimension === "error_codes" ? "high" : "medium",
    priority: "P1",
    owner_phase: "execute",
    executable_test_id: `unit::${dimension}`,
    test_file: "tests/unit.spec.ts",
    test_title: `${dimension}`,
    task_refs: ["task:publish"],
    requirement_refs: [] as string[]
  }));
  return {
    change_key: CHANGE_KEY,
    risk_signals: options?.assurance === true ? ["migration"] : ["production_code"],
    intent: {
      source_input: "把 plan 发布编排收口",
      goal,
      user_visible_outcome: approvalContent.user_visible_outcome,
      in_scope: approvalContent.in_scope,
      out_of_scope: approvalContent.out_of_scope,
      constraints: ["no_fs_write"],
      acceptance_examples: approvalContent.acceptance_examples
    },
    approval: { content: approvalContent, approver_id: "user:owner" },
    evidence_sources: [{
      source_kind: "map",
      source_id: "map:publish",
      source_version: "v1",
      content_hash: `sha256:${"c".repeat(64)}`,
      module_refs: ["plan_publish"],
      symbol_refs: ["runPlanPublish"],
      consumer_refs: ["cli"],
      test_refs: ["plan-publish.e2e.test.ts"],
      constraint_refs: ["no_fs_write"],
      unknown_refs: []
    }],
    structured_input: {
      change_key: CHANGE_KEY,
      tasks: [{
        task_id: "task:publish",
        objective: "编排收口实现",
        affected_paths: ["packages/cli/src/commands/plan-publish.ts"],
        depends_on: [],
        owner_phase: "execute",
        decision_refs: [],
        scenario_refs: scenarios.map((scenario) => scenario.scenario_id),
        requirement_refs: [],
        evidence_refs: ["module:plan_publish"],
        ownership_refs: []
      }],
      scenarios,
      approved_scopes: [{ text: "plan_publish" }]
    },
    machine: { capabilities: ["api"], worktree_policy: "project_default" },
    context: {
      project_id: "prj_publish",
      run_id: "run_publish01",
      branch_name: "main",
      attempt: 1
    },
    expected_baseline: { state: "absent", manifest_hash: null, generation: 0 }
  };
}

describe("HP-18：plan publish 编排收口（P3）", () => {
  let root: string;
  let realRoot: string;
  let inputPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "harness-plan-publish-"));
    await fs.mkdir(join(root, ".harness", "changes", CHANGE_KEY), { recursive: true });
    // finalize 按 realpath 解析发布位置；断言统一走 realpath，避免 CI 上 tmpdir
    // 被别名化（8.3 短名/软链）时拿到词法路径的假 ENOENT
    realRoot = await fs.realpath(root);
    inputPath = join(root, "plan-evidence-input.json");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const deps = (outputs: string[]) => ({
    cwd: root,
    stdout: (chunk: string) => { outputs.push(chunk); return true; },
    stderr: () => true,
    gitExec: stubGitExec
  });

  async function writeInput(input: unknown): Promise<void> {
    await fs.writeFile(inputPath, JSON.stringify(input));
  }

  it("首发：一条命令完成 evidence-pack → finalize，八 target 落盘", async () => {
    await writeInput(naturalInput());

    const out: string[] = [];
    const exit = await runPlanPublish({ input: inputPath }, deps(out));

    if (exit !== 0) console.error("PUBLISH-OUT:", out.join(""));
    expect(exit).toBe(0);
    const result = JSON.parse(out.join("")) as {
      code: string;
      steps: { evidence_pack: { code: string }; finalize: { code: string } };
    };
    expect(result.code).toBe("PLAN_PUBLISHED");
    expect(result.steps.evidence_pack.code).toBe("PLAN_EVIDENCE_PACK_BUILT");
    expect(result.steps.finalize.code).toBe("PLAN_FINALIZED");
    for (const path of planDurablePublicationTargetPaths(CHANGE_KEY)) {
      await fs.access(join(realRoot, ".harness", "changes", CHANGE_KEY, path));
    }
  });

  it("重发布：baseline 从 journal 自动派生（generation 递增）、attempt 自动递增", async () => {
    await writeInput(naturalInput());
    const firstOut: string[] = [];
    expect(await runPlanPublish({ input: inputPath }, deps(firstOut))).toBe(0);

    // 改了内容（goal 变化）再发布——输入里 baseline/attempt 都没动，由 publish 记账
    await writeInput(naturalInput({ goal: "编排收口端到端验证 v2" }));
    const secondOut: string[] = [];
    const exit = await runPlanPublish({ input: inputPath }, deps(secondOut));

    if (exit !== 0) console.error("PUBLISH2-OUT:", secondOut.join(""));
    expect(exit).toBe(0);
    const result = JSON.parse(secondOut.join("")) as {
      code: string;
      steps: {
        bookkeeping: {
          baseline: { state: string; generation: number } | string;
          attempt_adjusted: { from: number; to: number } | null;
        };
      };
    };
    expect(result.code).toBe("PLAN_PUBLISHED");
    expect(result.steps.bookkeeping.baseline).toMatchObject({ state: "present", generation: 1 });
    expect(result.steps.bookkeeping.attempt_adjusted).toEqual({ from: 1, to: 2 });
  });

  it("高风险变更无评审收据：停在 finalize 并给出 review-record 指引", async () => {
    await writeInput(naturalInput({ assurance: true }));

    const out: string[] = [];
    const exit = await runPlanPublish({ input: inputPath }, deps(out));

    expect(exit).toBe(1);
    const result = JSON.parse(out.join("")) as {
      code: string; failed_step: string; guidance?: { review?: string };
      steps: { evidence_pack: { code: string } };
    };
    expect(result.code).toBe("PLAN_REVIEW_REQUIRED");
    expect(result.failed_step).toBe("finalize");
    expect(result.steps.evidence_pack.code).toBe("PLAN_EVIDENCE_PACK_BUILT");
    expect(result.guidance?.review).toContain("review-record");
  });

  it("高风险变更：记录收据后发布；内容修订 + --renew-review 自动续签再发布（P2+P3 闭环）", async () => {
    await writeInput(naturalInput({ assurance: true }));
    const firstOut: string[] = [];
    expect(await runPlanPublish({ input: inputPath }, deps(firstOut))).toBe(1);

    // 评审：在证据包上记录收据，再把收据写回自然输入（重跑 evidence-pack 时透传）
    const packPath = join(root, "plan-evidence.json");
    const draftPath = join(root, "draft.json");
    await fs.writeFile(draftPath, JSON.stringify({ reviewer_identity: "inline:main-session" }));
    const recordOut: string[] = [];
    const recordExit = await runPlanReviewRecord(
      { input: packPath, receipt: draftPath }, deps(recordOut));
    if (recordExit !== 0) console.error("RECORD-OUT:", recordOut.join(""));
    expect(recordExit).toBe(0);
    const pack = JSON.parse(await fs.readFile(packPath, "utf8")) as Record<string, unknown>;
    const inputWithReview = { ...naturalInput({ assurance: true }),
      adversarial_review: pack.adversarial_review };
    await writeInput(inputWithReview);

    // 重建后收据必然过期（派生时间戳变），--renew-review 自动续签后发布成功
    const secondOut: string[] = [];
    const exit = await runPlanPublish({ input: inputPath, renewReview: true }, deps(secondOut));
    if (exit !== 0) console.error("PUBLISH2-OUT:", secondOut.join(""));
    expect(exit).toBe(0);
    const second = JSON.parse(secondOut.join("")) as {
      code: string;
      steps: { review_renew: { code: string; renewed: boolean } };
    };
    expect(second.code).toBe("PLAN_PUBLISHED");
    expect(second.steps.review_renew.code).toBe("PLAN_REVIEW_RECEIPT_RENEWED");
    expect(second.steps.review_renew.renewed).toBe(true);

    // 内容修订（goal 变化）再发布：续签仍然一条命令闭环
    await writeInput({ ...naturalInput({ assurance: true, goal: "编排收口端到端验证 v2" }),
      adversarial_review: pack.adversarial_review });
    const thirdOut: string[] = [];
    const thirdExit = await runPlanPublish({ input: inputPath, renewReview: true }, deps(thirdOut));
    if (thirdExit !== 0) console.error("PUBLISH3-OUT:", thirdOut.join(""));
    expect(thirdExit).toBe(0);
    const third = JSON.parse(thirdOut.join("")) as {
      code: string;
      steps: {
        review_renew: { renewed: boolean };
        bookkeeping: { baseline: { state: string; generation: number } | string };
      };
    };
    expect(third.code).toBe("PLAN_PUBLISHED");
    expect(third.steps.review_renew.renewed).toBe(true);
    expect(third.steps.bookkeeping.baseline).toMatchObject({ state: "present", generation: 1 });
  });

  it("输入缺 change_key 在边界报出（HP-18）", async () => {
    await writeInput({ intent: {} });

    const out: string[] = [];
    const exit = await runPlanPublish({ input: inputPath }, deps(out));

    expect(exit).toBe(1);
    expect(JSON.parse(out.join("")).code).toBe("PLAN_PUBLISH_USAGE");
  });
});
