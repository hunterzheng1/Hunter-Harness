import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHash } from "node:crypto";
import { canonicalJson } from "@hunter-harness/contracts";
import { createPlanQualityModule, createPlanStageVerifier } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runPlanEvidencePack } from "../src/commands/plan-evidence-pack.js";
import { runPlanFinalize } from "../src/commands/plan-finalize.js";

const CHANGE_KEY = "change-review01";
const dimensions = ["business_rules", "concurrency_idempotency", "data_compatibility", "error_codes",
  "integration_impact", "normal_path", "parameter_validation", "permission_boundaries"] as const;

const sha256Tagged = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;

// 与 plan-evidence-pack e2e 同一形状，仅把风险信号换成 assurance（migration）
// 并让 error_codes 场景为 high（同时覆盖高风险路径）
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
    owner_phase: "run",
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
        objective: "双写过渡实现",
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
      approved_scopes: [{ text: "plan_bridge" }]
    },
    machine: { capabilities: ["api"], worktree_policy: "project_default" },
    context: {
      project_id: "prj_review",
      run_id: "plan_review01",
      branch_name: "main",
      attempt: 1
    },
    expected_baseline: { state: "absent", manifest_hash: null, generation: 0 }
  };
}

const FIXED_TIME = "2026-08-16T12:00:00.000Z";

describe("HP-01：assurance 对抗评审收据接线", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "harness-review-"));
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

  async function buildPack(): Promise<Record<string, unknown>> {
    const inputPath = join(root, "natural.json");
    const packPath = join(root, "evidence.json");
    await fs.writeFile(inputPath, JSON.stringify(naturalInput()));
    const out: string[] = [];
    const exit = await runPlanEvidencePack({ input: inputPath, output: packPath }, deps(out));
    if (exit !== 0) console.error("PACK-OUT:", out.join(""));
    expect(exit).toBe(0);
    return JSON.parse(await fs.readFile(packPath, "utf8")) as Record<string, unknown>;
  }

  async function layer3InputHash(pack: Record<string, unknown>): Promise<string> {
    const quality = createPlanQualityModule();
    const completedAt = FIXED_TIME;
    const layer1 = quality.runDeterministicGates({
      trusted: pack.trusted as never,
      publication: pack.publication as never,
      stage_verifier_port: createPlanStageVerifier({ now: () => completedAt }),
      completed_at: completedAt
    });
    expect(layer1.status).toBe("passed");
    const layer2 = quality.runSemanticGates({ trusted: pack.trusted as never, completed_at: completedAt });
    const layer3 = quality.runAdversarialGates({
      trusted: pack.trusted as never,
      semantic: layer2,
      explicit_adversarial: false,
      prefer_delegated: false,
      completed_at: completedAt
    });
    return layer3.input_hash;
  }

  it("assurance 无评审收据 → PLAN_REVIEW_REQUIRED（可操作错误）", async () => {
    const pack = await buildPack();
    const packPath = join(root, "evidence.json");
    await fs.writeFile(packPath, JSON.stringify(pack));
    const out: string[] = [];
    const exit = await runPlanFinalize({ input: packPath }, deps(out));
    expect(exit).toBe(1);
    const result = JSON.parse(out.join("")) as { code: string };
    expect(result.code).toBe("PLAN_REVIEW_REQUIRED");
  });

  it("匹配的 inline 收据 → Layer 3 通过并 finalize 成功", async () => {
    const pack = await buildPack();
    const inputHash = await layer3InputHash(pack);
    const receipt = {
      schema_version: 1,
      reviewer_identity: "inline:test-reviewer",
      review_mode: "inline",
      input_hash: inputHash,
      findings_hash: sha256Tagged([]),
      findings: [],
      completed_at: "2026-08-16T11:00:00.000Z"
    };
    const packPath = join(root, "evidence.json");
    await fs.writeFile(packPath, JSON.stringify({ ...pack, adversarial_review: receipt }));
    const out: string[] = [];
    const exit = await runPlanFinalize({ input: packPath, completedAt: FIXED_TIME }, deps(out));
    if (exit !== 0) console.error("FIN-OUT:", out.join(""));
    expect(exit).toBe(0);
    expect(JSON.parse(out.join("")).code).toBe("PLAN_FINALIZED");
  });

  it("篡改 input_hash → PLAN_REVIEW_BINDING_FAILED", async () => {
    const pack = await buildPack();
    const receipt = {
      schema_version: 1,
      reviewer_identity: "inline:test-reviewer",
      review_mode: "inline",
      input_hash: `sha256:${"f".repeat(64)}`,
      findings_hash: sha256Tagged([]),
      findings: [],
      completed_at: "2026-08-16T11:00:00.000Z"
    };
    const packPath = join(root, "evidence.json");
    await fs.writeFile(packPath, JSON.stringify({ ...pack, adversarial_review: receipt }));
    const out: string[] = [];
    const exit = await runPlanFinalize({ input: packPath }, deps(out));
    expect(exit).toBe(1);
    expect(JSON.parse(out.join("")).code).toBe("PLAN_REVIEW_BINDING_FAILED");
  });

  it("findings_hash 与 findings 不符 → PLAN_REVIEW_BINDING_FAILED", async () => {
    const pack = await buildPack();
    const inputHash = await layer3InputHash(pack);
    const receipt = {
      schema_version: 1,
      reviewer_identity: "inline:test-reviewer",
      review_mode: "inline",
      input_hash: inputHash,
      findings_hash: `sha256:${"e".repeat(64)}`,
      findings: [],
      completed_at: "2026-08-16T11:00:00.000Z"
    };
    const packPath = join(root, "evidence.json");
    await fs.writeFile(packPath, JSON.stringify({ ...pack, adversarial_review: receipt }));
    const out: string[] = [];
    const exit = await runPlanFinalize({ input: packPath }, deps(out));
    expect(exit).toBe(1);
    expect(JSON.parse(out.join("")).code).toBe("PLAN_REVIEW_BINDING_FAILED");
  });
});
