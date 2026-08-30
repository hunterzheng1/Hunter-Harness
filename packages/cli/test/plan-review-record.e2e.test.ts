import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { runPlanEvidencePack } from "../src/commands/plan-evidence-pack.js";
import { runPlanFinalize } from "../src/commands/plan-finalize.js";
import { runPlanReviewRecord } from "../src/commands/plan-review-record.js";

const CHANGE_KEY = "change-review02";
const dimensions = ["business_rules", "concurrency_idempotency", "data_compatibility", "error_codes",
  "integration_impact", "normal_path", "parameter_validation", "permission_boundaries"] as const;

// 与 plan-finalize-review e2e 同一形状：assurance（migration 信号）+ 一条 high 风险场景
function naturalInput() {
  const approvalContent = {
    goal: "迁移路径可回滚",
    user_visible_outcome: "迁移失败可恢复",
    in_scope: ["plan_bridge"],
    out_of_scope: ["legacy_ui"],
    recommended_design: "双写过渡后切换",
    key_alternatives: ["直接迁移"],
    invariants: ["旧路径可读"],
    failure_behaviors: ["切换失败回退"],
    compatibility_boundaries: ["旧数据格式只读兼容"],
    risks: [{ risk: "双写不一致", mitigation: "一致性校验后切换" }],
    acceptance_examples: ["中断回滚", "一致性校验", "回退可用"]
  };
  const scenarios = dimensions.map((dimension, index) => ({
    scenario_id: `scenario:${dimension}`,
    title: `场景 ${dimension}`,
    acceptance: "迁移证据闭合",
    coverage_dimension: dimension,
    execution_level: (index === 0 ? "unit" : "integration"),
    evidence_requirements: ["focused_test"],
    risk_level: dimension === "error_codes" ? "high" : "medium",
    priority: "P1",
    owner_phase: "execute",
    executable_test_id: `unit::${dimension}`,
    test_file: "tests/unit.spec.ts",
    test_title: `${dimension}`,
    task_refs: ["task:bridge"],
    requirement_refs: [] as string[]
  }));
  return {
    change_key: CHANGE_KEY,
    risk_signals: ["migration"],
    intent: {
      source_input: "增加迁移保障",
      goal: approvalContent.goal,
      user_visible_outcome: approvalContent.user_visible_outcome,
      in_scope: approvalContent.in_scope,
      out_of_scope: approvalContent.out_of_scope,
      constraints: ["no_fs_write"],
      acceptance_examples: approvalContent.acceptance_examples
    },
    approval: { content: approvalContent, approver_id: "user:owner" },
    evidence_sources: [{
      source_kind: "map",
      source_id: "map:bridge",
      source_version: "v1",
      content_hash: `sha256:${"b".repeat(64)}`,
      module_refs: ["plan_bridge"],
      symbol_refs: ["runPlanEvidencePack"],
      consumer_refs: ["cli"],
      test_refs: ["plan-evidence-pack.e2e.test.ts"],
      constraint_refs: ["no_fs_write"],
      unknown_refs: []
    }],
    structured_input: {
      change_key: CHANGE_KEY,
      tasks: [{
        task_id: "task:bridge",
        objective: "双写过渡实现",
        affected_paths: ["packages/cli/src/commands/plan-evidence-pack.ts"],
        depends_on: [],
        owner_phase: "execute",
        decision_refs: [],
        scenario_refs: scenarios.map((scenario) => scenario.scenario_id),
        requirement_refs: [],
        evidence_refs: ["module:plan_bridge"],
        ownership_refs: []
      }],
      scenarios,
      approved_scopes: [{ text: "plan_bridge" }]
    },
    machine: { capabilities: ["api"], worktree_policy: "project_default" },
    context: {
      project_id: "prj_review",
      run_id: "plan_review02",
      branch_name: "main",
      attempt: 1
    },
    expected_baseline: { state: "absent", manifest_hash: null, generation: 0 }
  };
}

describe("HP-15：plan review-record 收 Receipt 链路（P0-1）", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "harness-review-record-"));
    await fs.mkdir(join(root, ".harness", "changes", CHANGE_KEY), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const deps = (outputs: string[]) => ({
    cwd: root,
    stdout: (chunk: string) => { outputs.push(chunk); return true; },
    stderr: () => true
  });

  async function buildPack(): Promise<string> {
    const inputPath = join(root, "natural.json");
    const packPath = join(root, "evidence.json");
    await fs.writeFile(inputPath, JSON.stringify(naturalInput()));
    const out: string[] = [];
    const exit = await runPlanEvidencePack({ input: inputPath, output: packPath }, deps(out));
    if (exit !== 0) console.error("PACK-OUT:", out.join(""));
    expect(exit).toBe(0);
    return packPath;
  }

  async function writeDraft(draft: unknown): Promise<string> {
    const draftPath = join(root, `draft-${Math.random().toString(36).slice(2)}.json`);
    await fs.writeFile(draftPath, JSON.stringify(draft));
    return draftPath;
  }

  it("PLAN_REVIEW_REQUIRED 报错自曝期望 input_hash（公开契约）", async () => {
    const packPath = await buildPack();
    const out: string[] = [];
    const exit = await runPlanFinalize({ input: packPath }, deps(out));
    expect(exit).toBe(1);
    const result = JSON.parse(out.join("")) as {
      code: string;
      expected_review?: { input_hash: string };
      message?: string;
    };
    expect(result.code).toBe("PLAN_REVIEW_REQUIRED");
    expect(result.expected_review?.input_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.message).toContain("review-record");
  });

  it("草稿只给 reviewer_identity/findings，CLI 代算两个哈希并写回，finalize 一次通过", async () => {
    const packPath = await buildPack();
    const draftPath = await writeDraft({
      reviewer_identity: "inline:main-session",
      findings: []
    });

    const recordOut: string[] = [];
    const recordExit = await runPlanReviewRecord(
      { input: packPath, receipt: draftPath }, deps(recordOut));
    if (recordExit !== 0) console.error("RECORD-OUT:", recordOut.join(""));
    expect(recordExit).toBe(0);
    const recordResult = JSON.parse(recordOut.join("")) as {
      code: string; review_required: boolean; input_hash: string; findings_hash: string;
    };
    expect(recordResult.code).toBe("PLAN_REVIEW_RECEIPT_RECORDED");
    expect(recordResult.review_required).toBe(true);

    // 缺省 in-place 写回：pack 顶层出现 adversarial_review
    const pack = JSON.parse(await fs.readFile(packPath, "utf8")) as {
      adversarial_review?: { input_hash: string; findings_hash: string; review_mode: string };
    };
    expect(pack.adversarial_review?.input_hash).toBe(recordResult.input_hash);
    expect(pack.adversarial_review?.findings_hash).toBe(recordResult.findings_hash);
    expect(pack.adversarial_review?.review_mode).toBe("inline");

    const finOut: string[] = [];
    const finExit = await runPlanFinalize({ input: packPath }, deps(finOut));
    if (finExit !== 0) console.error("FIN-OUT:", finOut.join(""));
    expect(finExit).toBe(0);
    expect(JSON.parse(finOut.join("")).code).toBe("PLAN_FINALIZED");
  });

  it("报错里的期望 input_hash 与 review-record 算出的权威值一致", async () => {
    const packPath = await buildPack();
    const finOut: string[] = [];
    await runPlanFinalize({ input: packPath }, deps(finOut));
    const expected = (JSON.parse(finOut.join("")) as {
      expected_review: { input_hash: string };
    }).expected_review.input_hash;

    const draftPath = await writeDraft({ reviewer_identity: "inline:main-session" });
    const recordOut: string[] = [];
    const recordExit = await runPlanReviewRecord(
      { input: packPath, receipt: draftPath }, deps(recordOut));
    expect(recordExit).toBe(0);
    expect((JSON.parse(recordOut.join("")) as { input_hash: string }).input_hash).toBe(expected);
  });

  it("草稿夹带 input_hash 等派生键在边界被拒（哈希由命令代算，不接受手填）", async () => {
    const packPath = await buildPack();
    const draftPath = await writeDraft({
      reviewer_identity: "inline:main-session",
      input_hash: `sha256:${"0".repeat(64)}`
    });

    const out: string[] = [];
    const exit = await runPlanReviewRecord({ input: packPath, receipt: draftPath }, deps(out));

    expect(exit).toBe(1);
    const result = JSON.parse(out.join("")) as {
      code: string; stage: string; problems?: { field_path: string; message?: string }[];
    };
    expect(result.code).toBe("PLAN_REVIEW_RECORD_INPUT_INVALID");
    expect(result.stage).toBe("boundary");
    expect(result.problems?.[0]?.message).toContain("input_hash");
  });

  it("findings 形状不合法时在边界逐条报出", async () => {
    const packPath = await buildPack();
    const draftPath = await writeDraft({
      reviewer_identity: "inline:main-session",
      findings: [{ finding_id: "Bad Id!", severity: "critical" }]
    });

    const out: string[] = [];
    const exit = await runPlanReviewRecord({ input: packPath, receipt: draftPath }, deps(out));

    expect(exit).toBe(1);
    const result = JSON.parse(out.join("")) as {
      code: string; problems?: { field_path: string }[];
    };
    expect(result.code).toBe("PLAN_REVIEW_RECORD_INPUT_INVALID");
    expect(result.problems?.[0]?.field_path).toBe("receipt.findings[0]");
  });

  it("篡改写回后的收据 → finalize 绑定失败（PLAN_REVIEW_BINDING_FAILED）", async () => {
    const packPath = await buildPack();
    const draftPath = await writeDraft({ reviewer_identity: "inline:main-session" });
    const recordOut: string[] = [];
    expect(await runPlanReviewRecord({ input: packPath, receipt: draftPath }, deps(recordOut)))
      .toBe(0);

    const pack = JSON.parse(await fs.readFile(packPath, "utf8")) as Record<string, unknown> & {
      adversarial_review: Record<string, unknown>;
    };
    pack.adversarial_review.input_hash = `sha256:${"f".repeat(64)}`;
    await fs.writeFile(packPath, JSON.stringify(pack));

    const out: string[] = [];
    const exit = await runPlanFinalize({ input: packPath }, deps(out));
    expect(exit).toBe(1);
    expect(JSON.parse(out.join("")).code).toBe("PLAN_REVIEW_BINDING_FAILED");
  });

  it("写回后重跑 evidence-pack 会使收据失效（收据绑定 pack 内容）", async () => {
    const packPath = await buildPack();
    const draftPath = await writeDraft({ reviewer_identity: "inline:main-session" });
    const recordOut: string[] = [];
    expect(await runPlanReviewRecord({ input: packPath, receipt: draftPath }, deps(recordOut)))
      .toBe(0);

    // 任何重建（即使内容等价，命令派生的时间戳字段也会变）都使旧收据失效
    const input = naturalInput();
    input.intent.goal = "迁移路径可回滚且可观测";
    input.approval.content.goal = "迁移路径可回滚且可观测";
    const inputPath = join(root, "natural-v2.json");
    await fs.writeFile(inputPath, JSON.stringify(input));
    const rebuiltPath = join(root, "evidence-v2.json");
    const packOut: string[] = [];
    expect(await runPlanEvidencePack({ input: inputPath, output: rebuiltPath }, deps(packOut)))
      .toBe(0);
    // 把旧收据贴进新 pack——input_hash 已变，绑定必须失败
    const oldPack = JSON.parse(await fs.readFile(packPath, "utf8")) as Record<string, unknown>;
    const rebuilt = JSON.parse(await fs.readFile(rebuiltPath, "utf8")) as Record<string, unknown>;
    rebuilt.adversarial_review = oldPack.adversarial_review;
    await fs.writeFile(rebuiltPath, JSON.stringify(rebuilt));

    const out: string[] = [];
    const exit = await runPlanFinalize({ input: rebuiltPath }, deps(out));
    expect(exit).toBe(1);
    expect(JSON.parse(out.join("")).code).toBe("PLAN_REVIEW_BINDING_FAILED");
  });
});
