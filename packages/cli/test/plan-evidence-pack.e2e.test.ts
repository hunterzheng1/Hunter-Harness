import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planDurablePublicationTargetPaths } from "@hunter-harness/core";

import { runPlanEvidencePack } from "../src/commands/plan-evidence-pack.js";
import { runPlanFinalize } from "../src/commands/plan-finalize.js";

const CHANGE_KEY = "pack-bridge01";
const dimensions = ["business_rules", "concurrency_idempotency", "data_compatibility", "error_codes",
  "integration_impact", "normal_path", "parameter_validation", "permission_boundaries"] as const;

function naturalInput() {
  const approvalContent = {
    goal: "证据包桥端到端验证",
    user_visible_outcome: "自然输入完成 v2 发布",
    in_scope: ["plan_bridge"],
    out_of_scope: ["python_finalizer"],
    recommended_design: "三层收据驱动唯一发布意图",
    key_alternatives: ["继续依赖叙述式自检"],
    invariants: ["结构失败绝不发布"],
    failure_behaviors: ["结构失败绝不发布"],
    compatibility_boundaries: ["旧质量记录只读"],
    risks: [{ risk: "评审循环", mitigation: "委派失败最多一次 inline fallback" }],
    acceptance_examples: ["standard 执行语义层", "结构失败绝不发布", "发布证据闭合"]
  };
  const scenarios = dimensions.map((dimension, index) => ({
    scenario_id: `scenario:${dimension}`,
    title: `场景 ${dimension}`,
    acceptance: "发布证据闭合",
    coverage_dimension: dimension,
    execution_level: (index === 0 ? "unit" : "integration"),
    evidence_requirements: ["focused_test"],
    risk_level: "medium",
    task_refs: ["task:bridge"],
    requirement_refs: [] as string[]
  }));
  return {
    change_key: CHANGE_KEY,
    risk_signals: ["production_code", "cross_file"],
    intent: {
      source_input: "证据包桥端到端验证",
      goal: approvalContent.goal,
      user_visible_outcome: approvalContent.user_visible_outcome,
      in_scope: approvalContent.in_scope,
      out_of_scope: approvalContent.out_of_scope,
      constraints: ["no_fs_write"],
      acceptance_examples: approvalContent.acceptance_examples
    },
    approval: {
      content: approvalContent,
      approver_id: "user:owner"
    },
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
        objective: "证据包桥验证",
        affected_paths: ["packages/cli/src/commands/plan-evidence-pack.ts"],
        depends_on: [],
        owner_phase: "run",
        decision_refs: [],
        scenario_refs: scenarios.map((scenario) => scenario.scenario_id),
        requirement_refs: [],
        evidence_refs: ["module:plan_bridge"],
        ownership_refs: []
      }],
      scenarios,
      approved_scopes: [{ scope_ref: "scope:" + "b".repeat(64), text: "plan_bridge" }]
    },
    machine: { capabilities: ["api"], worktree_policy: "project_default" },
    context: {
      project_id: "prj_bridge",
      run_id: "run_bridge01",
      branch_name: "main",
      attempt: 1
    },
    expected_baseline: { state: "absent", manifest_hash: null, generation: 0 }
  };
}

describe("hunter-harness plan evidence-pack → finalize (阶段 14 桥 e2e)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "harness-evidence-pack-"));
    await fs.mkdir(join(root, ".harness", "changes", CHANGE_KEY), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("builds an evidence pack from natural inputs that finalizes cleanly", async () => {
    const inputPath = join(root, "natural.json");
    const packPath = join(root, "evidence.json");
    await fs.writeFile(inputPath, JSON.stringify(naturalInput()));

    const deps = (outputs: string[]) => ({
      cwd: root,
      stdout: (chunk: string) => { outputs.push(chunk); return true; },
      stderr: () => true
    });

    const packOut: string[] = [];
    const packExit = await runPlanEvidencePack({ input: inputPath, output: packPath }, deps(packOut));
    if (packExit !== 0) console.error("PACK-OUT:", packOut.join(""));
    expect(packExit).toBe(0);

    const finalizeOut: string[] = [];
    const finalizeExit = await runPlanFinalize({ input: packPath }, deps(finalizeOut));
    if (finalizeExit !== 0) console.error("FIN-OUT:", finalizeOut.join(""));
    expect(finalizeExit).toBe(0);
    const result = JSON.parse(finalizeOut.join("")) as { ok: boolean; code: string };
    expect(result.ok).toBe(true);
    expect(result.code).toBe("PLAN_FINALIZED");

    for (const path of planDurablePublicationTargetPaths(CHANGE_KEY)) {
      await fs.access(join(root, ".harness", "changes", CHANGE_KEY, path));
    }
    const ndjson = await fs.readFile(
      join(root, ".harness", "changes", CHANGE_KEY, "meta", "plan-events.ndjson"), "utf8");
    expect(ndjson.trim().split("\n").length).toBeGreaterThan(0);
  });
});
