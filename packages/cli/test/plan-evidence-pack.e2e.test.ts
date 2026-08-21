import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planDurablePublicationTargetPaths } from "@hunter-harness/core";

import { runPlanEvidencePack } from "../src/commands/plan-evidence-pack.js";
import { runPlanFinalize } from "../src/commands/plan-finalize.js";

// tmpdir 不是 git 仓库：既有用例统一注入 stub（is_git:true, has_remote:true），
// 探针行为本身由 git-probe.test.ts 覆盖。
const stubGitExec = async (args: readonly string[]): Promise<string> => {
  const key = args.join(" ");
  if (key === "rev-parse --is-inside-work-tree") return "true\n";
  if (key === "remote") return "origin\n";
  if (key === "rev-parse --git-dir") return ".git\n";
  if (key === "rev-parse --git-common-dir") return ".git\n";
  if (key === "status --porcelain --untracked-files=all") return "";
  throw new Error(`unexpected git call: ${key}`);
};

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
      cwd: root, gitExec: stubGitExec,
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

  it("attempt=2 finalization bundle 通过质量验证（HP-02）", async () => {
    const inputPath = join(root, "natural-attempt2.json");
    const packPath = join(root, "evidence-attempt2.json");
    const natural = naturalInput() as { context: { attempt: number } };
    natural.context.attempt = 2;
    await fs.writeFile(inputPath, JSON.stringify(natural));

    const deps = (outputs: string[]) => ({
      cwd: root, gitExec: stubGitExec,
      stdout: (chunk: string) => { outputs.push(chunk); return true; },
      stderr: () => true
    });
    const packOut: string[] = [];
    expect(await runPlanEvidencePack({ input: inputPath, output: packPath }, deps(packOut))).toBe(0);
    const finalizeOut: string[] = [];
    const finalizeExit = await runPlanFinalize({ input: packPath }, deps(finalizeOut));
    if (finalizeExit !== 0) console.error("FIN2-OUT:", finalizeOut.join(""));
    expect(finalizeExit).toBe(0);
    const result = JSON.parse(finalizeOut.join("")) as { ok: boolean; code: string };
    expect(result.code).toBe("PLAN_FINALIZED");
    const ndjson = await fs.readFile(
      join(root, ".harness", "changes", CHANGE_KEY, "meta", "plan-events.ndjson"), "utf8");
    const events = ndjson.trim().split("\n")
      .map((line) => JSON.parse(line) as { attempt: number; type: string });
    expect(events.every((event) => event.attempt === 2)).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["phase_started", "artifact_published", "phase_ended"]);
  });

  it("HP-07：数字开头的 run_id 在边界拒绝并给出字段路径", async () => {
    const inputPath = join(root, "bad-run-id.json");
    const natural = naturalInput() as { context: { run_id: string } };
    natural.context.run_id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    await fs.writeFile(inputPath, JSON.stringify(natural));
    const out: string[] = [];
    const exit = await runPlanEvidencePack({ input: inputPath, output: join(root, "x.json") }, {
      cwd: root, gitExec: stubGitExec, stdout: (chunk: string) => { out.push(chunk); return true; }, stderr: () => true
    });
    expect(exit).toBe(1);
    const result = JSON.parse(out.join("")) as {
      code: string; field_path: string; stage: string; reason_code: string; retryable: boolean;
    };
    expect(result.code).toBe("PLAN_RUN_ID_INVALID");
    expect(result.field_path).toBe("context.run_id");
    // HP-08 信封定位字段
    expect(result.stage).toBe("boundary");
    expect(result.reason_code).toBe("PLAN_RUN_ID_INVALID");
    expect(result.retryable).toBe(false);
  });

  it("HP-11：等价的 +08:00 与 Z 时间生成相同产物身份", async () => {
    const buildWithTime = async (decidedAt: string, dir: string) => {
      await fs.mkdir(join(dir, ".harness", "changes", CHANGE_KEY), { recursive: true });
      const natural = naturalInput() as { approval: { decided_at?: string } };
      natural.approval.decided_at = decidedAt;
      const inputPath = join(dir, "natural.json");
      const packPath = join(dir, "pack.json");
      await fs.writeFile(inputPath, JSON.stringify(natural));
      const out: string[] = [];
      const exit = await runPlanEvidencePack({ input: inputPath, output: packPath }, {
        cwd: dir, gitExec: stubGitExec, stdout: (chunk: string) => { out.push(chunk); return true; }, stderr: () => true
      });
      expect(exit).toBe(0);
      return JSON.parse(await fs.readFile(packPath, "utf8")) as {
        publication: { publication_intent_id: string };
      };
    };
    const withOffset = await buildWithTime("2026-08-17T03:44:55.964+08:00", join(root, "a"));
    const withZulu = await buildWithTime("2026-08-16T19:44:55.964Z", join(root, "b"));
    expect(withOffset.publication.publication_intent_id)
      .toBe(withZulu.publication.publication_intent_id);
  });

  it("HP-04：scope 顺序差异不触发语义 finding；真实缺失给出 diff", async () => {
    const inputPath = join(root, "scope-reordered.json");
    const natural = naturalInput() as {
      intent: { in_scope: string[]; out_of_scope: string[] };
      approval: { content: { in_scope: string[] } };
    };
    // intent 与 approval 同集合、顺序不同 → 应通过
    natural.intent.in_scope = ["plan_bridge", "zz_extra_order"];
    natural.approval.content.in_scope = ["zz_extra_order", "plan_bridge"];
    (natural as unknown as { structured_input: { approved_scopes: { text: string }[] } })
      .structured_input.approved_scopes = [
        { text: "plan_bridge" },
        { text: "zz_extra_order" }
      ];
    await fs.writeFile(inputPath, JSON.stringify(natural));
    const out1: string[] = [];
    const exit1 = await runPlanEvidencePack({ input: inputPath, output: join(root, "scope1.json") }, {
      cwd: root, gitExec: stubGitExec, stdout: (chunk: string) => { out1.push(chunk); return true; }, stderr: () => true
    });
    expect(exit1).toBe(0);

    // 真实缺失 → PLAN_SCOPE_MISMATCH 带 missing/extra 明细
    const natural2 = naturalInput() as { approval: { content: { in_scope: string[] } } };
    natural2.approval.content.in_scope = ["plan_bridge", "extra_not_in_intent"];
    await fs.writeFile(inputPath, JSON.stringify(natural2));
    const out2: string[] = [];
    const exit2 = await runPlanEvidencePack({ input: inputPath, output: join(root, "scope2.json") }, {
      cwd: root, gitExec: stubGitExec, stdout: (chunk: string) => { out2.push(chunk); return true; }, stderr: () => true
    });
    expect(exit2).toBe(1);
    const result = JSON.parse(out2.join("")) as { code: string; diff: { in_scope: { missing: string[] } } };
    expect(result.code).toBe("PLAN_SCOPE_MISMATCH");
    expect(result.diff.in_scope.missing).toContain("extra_not_in_intent");
  });

  it("HP-05：文本顺序≠ref 哈希顺序的多 scope/多同 kind requirement/多 ownership 隐式路径全通", async () => {
    const natural = naturalInput() as {
      intent: { in_scope: string[] };
      approval: { content: { in_scope: string[]; invariants: string[] } };
      structured_input: {
        approved_scopes: { text: string; scope_ref: string }[];
        tasks: { affected_paths: string[] }[];
      };
    };
    // 两个 scope：文本序与 ref 哈希序不同（测试内验证该前提）
    natural.intent.in_scope = ["alpha_scope", "beta_scope"];
    natural.approval.content.in_scope = ["beta_scope", "alpha_scope"];
    natural.structured_input.approved_scopes = [
      { text: "alpha_scope" },
      { text: "beta_scope" }
    ];
    // 多个同 kind requirement（不变量两条）
    natural.approval.content.invariants = ["结构失败绝不发布", "旧路径只读"];
    // 多个 ownership path
    natural.structured_input.tasks[0].affected_paths = ["a/x.ts", "b/y.ts", "c/z.ts"];
    const inputPath = join(root, "hp05.json");
    const packPath = join(root, "hp05-pack.json");
    await fs.writeFile(inputPath, JSON.stringify(natural));
    const out: string[] = [];
    const exit = await runPlanEvidencePack({ input: inputPath, output: packPath }, {
      cwd: root, gitExec: stubGitExec, stdout: (chunk: string) => { out.push(chunk); return true; }, stderr: () => true
    });
    if (exit !== 0) console.error("HP05-OUT:", out.join(""));
    expect(exit).toBe(0);
    const pack = JSON.parse(await fs.readFile(packPath, "utf8")) as {
      trusted: { human_input: { structured_input: {
        requirements: { requirement_id: string; approved_scope_refs: string[] }[];
        approved_scopes: { scope_ref: string; text: string }[];
      } } };
    };
    const scopes = pack.trusted.human_input.structured_input.approved_scopes;
    const textOrder = scopes.map((scope) => scope.text);
    const refOrder = [...scopes].map((scope) => scope.scope_ref).sort();
    const scopeRefByText = scopes.map((scope) => scope.scope_ref);
    expect(textOrder).toEqual([...textOrder].sort());
    // 前提成立：文本序 ≠ ref 序（否则换文本重跑本用例）
    expect(scopeRefByText).not.toEqual(refOrder);
    // 每条 requirement 的 scope refs 已按 ref canonical
    for (const requirement of pack.trusted.human_input.structured_input.requirements) {
      expect(requirement.approved_scope_refs).toEqual([...requirement.approved_scope_refs].sort());
    }
    const finalizeOut: string[] = [];
    const finalizeExit = await runPlanFinalize({ input: packPath }, {
      cwd: root, gitExec: stubGitExec, stdout: (chunk: string) => { finalizeOut.push(chunk); return true; }, stderr: () => true
    });
    if (finalizeExit !== 0) console.error("HP05-FIN:", finalizeOut.join(""));
    expect(finalizeExit).toBe(0);
  });


  it("HP-12：多任务反向推导引用 + 全量 fan-out 密度警告 + 伪 scope_ref 拒绝", async () => {
    const natural = naturalInput() as unknown as {
      structured_input: {
        tasks: Record<string, unknown>[];
        scenarios: Record<string, unknown>[];
      };
    };
    // 两个任务：task2 显式 scenario_refs=[scenario:normal_path]，
    // scenario 侧未显式 task_refs → 反向推导（scenario:normal_path 只连 task2）
    // 每个 scenario 都显式连接（4→t1，4→t2），闭包无回退
    natural.structured_input.scenarios = natural.structured_input.scenarios.map((scenario, index) => {
      const next = { ...scenario } as Record<string, unknown>;
      next.task_refs = [index % 2 === 0 ? "task:t1" : "task:t2"];
      return next;
    });
    natural.structured_input.tasks = ["task:t1", "task:t2"].map((taskId) => {
      const next = { ...natural.structured_input.tasks[0], task_id: taskId } as Record<string, unknown>;
      delete next.scenario_refs;
      return next;
    });
    const inputPath = join(root, "hp12.json");
    const packPath = join(root, "hp12-pack.json");
    await fs.writeFile(inputPath, JSON.stringify(natural));
    const out: string[] = [];
    const exit = await runPlanEvidencePack({ input: inputPath, output: packPath }, {
      cwd: root, gitExec: stubGitExec, stdout: (chunk: string) => { out.push(chunk); return true; }, stderr: () => true
    });
    if (exit !== 0) console.error("HP12-OUT:", out.join(""));
    expect(exit).toBe(0);
    const pack = JSON.parse(await fs.readFile(packPath, "utf8")) as {
      trusted: { human_input: { structured_input: {
        scenarios: { scenario_id: string; task_refs: string[] }[];
        tasks: { task_id: string; scenario_refs: string[] }[];
      } } };
    };
    const normal = pack.trusted.human_input.structured_input.scenarios
      .find((scenario) => scenario.scenario_id === "scenario:normal_path");
    // task2 显式引用 → scenario 反向推导只连 task2（非全量）
    expect(normal?.task_refs).toEqual(["task:t2"]);
    // 双侧均有显式/推导关系 → 无全量 fan-out 警告
    const output = JSON.parse(out.join("")) as { warnings?: string[] };
    expect(output.warnings ?? []).not.toContain("graph_density_full_fanout");

    // 全隐式多任务 → 全量 fan-out 警告
    const implicit = naturalInput() as unknown as {
      structured_input: {
        tasks: Record<string, unknown>[];
        scenarios: Record<string, unknown>[];
      };
    };
    implicit.structured_input.tasks = [
      { ...implicit.structured_input.tasks[0], task_id: "task:a", scenario_refs: undefined },
      { ...implicit.structured_input.tasks[0], task_id: "task:b", scenario_refs: undefined }
    ];
    implicit.structured_input.scenarios = implicit.structured_input.scenarios.map((scenario) => {
      const next = { ...scenario } as Record<string, unknown>;
      delete next.task_refs;
      return next;
    });
    await fs.writeFile(inputPath, JSON.stringify(implicit));
    const fanoutOut: string[] = [];
    expect(await runPlanEvidencePack({ input: inputPath, output: join(root, "fanout.json") }, {
      cwd: root, gitExec: stubGitExec, stdout: (chunk: string) => { fanoutOut.push(chunk); return true; }, stderr: () => true
    })).toBe(0);
    expect((JSON.parse(fanoutOut.join("")) as { warnings?: string[] }).warnings)
      .toContain("graph_density_full_fanout");

    // 伪 scope_ref（与派生不符）→ 拒绝
    const forged = naturalInput() as unknown as {
      structured_input: { approved_scopes: { scope_ref?: string; text: string }[] };
    };
    forged.structured_input.approved_scopes = [{ scope_ref: "scope:" + "9".repeat(64), text: "plan_bridge" }];
    await fs.writeFile(inputPath, JSON.stringify(forged));
    const forgedOut: string[] = [];
    const forgedExit = await runPlanEvidencePack({ input: inputPath, output: join(root, "forged.json") }, {
      cwd: root, gitExec: stubGitExec, stdout: (chunk: string) => { forgedOut.push(chunk); return true; }, stderr: () => true
    });
    expect(forgedExit).toBe(1);
    expect(JSON.parse(forgedOut.join("")).code).toBe("PLAN_SCOPE_REF_FORGED");
  });
});

describe("阶段 0.6 plannedPhases 接缝与 capabilities 探针", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "harness-pack-seam-"));
    await fs.mkdir(join(root, ".harness", "changes", CHANGE_KEY, "meta"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function packWithGatePolicy(policy: unknown | undefined) {
    if (policy !== undefined) {
      await fs.writeFile(
        join(root, ".harness", "changes", CHANGE_KEY, "meta", "gate-policy.json"),
        JSON.stringify(policy)
      );
    }
    const inputPath = join(root, "natural.json");
    const packPath = join(root, "pack.json");
    await fs.writeFile(inputPath, JSON.stringify(naturalInput()));
    const out: string[] = [];
    const exit = await runPlanEvidencePack({ input: inputPath, output: packPath }, {
      cwd: root, gitExec: stubGitExec, stdout: (chunk: string) => { out.push(chunk); return true; }, stderr: () => true
    });
    expect(exit).toBe(0);
    const pack = JSON.parse(await fs.readFile(packPath, "utf8")) as {
      trusted: { human_input: { phase_set: { planned_phases: string[] } } };
      context: { phase_set_source: string; capabilities_provenance: { probe: string } };
    };
    return { stdout: JSON.parse(out.join("")) as Record<string, unknown>, pack };
  }

  it("无 gate-policy.json → derived 派生（提交按探针能力判定）", async () => {
    const { pack } = await packWithGatePolicy(undefined);
    expect(pack.context.phase_set_source).toBe("derived");
    expect(pack.context.capabilities_provenance.probe).toBe("probe");
    expect(pack.trusted.human_input.phase_set.planned_phases)
      .toEqual(["plan", "execute", "submit", "archive"]);
  });

  it("权威 plannedPhases（含 submit）→ 照 0.6 计划", async () => {
    const { pack } = await packWithGatePolicy({
      schemaVersion: 1, plannedPhases: ["plan", "execute", "submit", "archive"]
    });
    expect(pack.context.phase_set_source).toBe("gate-policy");
    expect(pack.trusted.human_input.phase_set.planned_phases)
      .toEqual(["plan", "execute", "submit", "archive"]);
  });

  it("权威 plannedPhases（不含 submit）→ submit 记显式省略", async () => {
    const { pack } = await packWithGatePolicy({
      schemaVersion: 1, plannedPhases: ["plan", "execute", "archive"]
    });
    expect(pack.context.phase_set_source).toBe("gate-policy");
    expect(pack.trusted.human_input.phase_set.planned_phases)
      .toEqual(["plan", "execute", "archive"]);
  });

  it("旧名 plannedPhases（plan,run,test,archive）→ 归一去重后照用", async () => {
    const { pack } = await packWithGatePolicy({
      schemaVersion: 1, plannedPhases: ["plan", "run", "test", "archive"]
    });
    expect(pack.context.phase_set_source).toBe("gate-policy");
    expect(pack.trusted.human_input.phase_set.planned_phases)
      .toEqual(["plan", "execute", "archive"]);
  });

  it("v2 包装体形状（无顶层 plannedPhases）→ 回退 derived", async () => {
    const { pack } = await packWithGatePolicy({
      artifact_type: "gate_policy", content_hash: "sha256:" + "a".repeat(64),
      content: { planned_phases: ["plan", "archive"] }
    });
    expect(pack.context.phase_set_source).toBe("derived");
  });

  it("plannedPhases 缺 required（assurance 砍 review）→ required 保留并告警", async () => {
    const natural = naturalInput() as { risk_signals: string[] };
    natural.risk_signals = ["security", "payment"];
    const inputPath = join(root, "natural-assurance.json");
    await fs.writeFile(inputPath, JSON.stringify(natural));
    await fs.writeFile(
      join(root, ".harness", "changes", CHANGE_KEY, "meta", "gate-policy.json"),
      JSON.stringify({ schemaVersion: 1, plannedPhases: ["plan", "execute", "archive"] })
    );
    const out: string[] = [];
    const exit = await runPlanEvidencePack({ input: inputPath, output: join(root, "p.json") }, {
      cwd: root, gitExec: stubGitExec, stdout: (chunk: string) => { out.push(chunk); return true; }, stderr: () => true
    });
    expect(exit).toBe(0);
    const stdout = JSON.parse(out.join("")) as { warnings?: string[] };
    expect(stdout.warnings).toContain("phase_set_required_retained");
  });

  it("provenance 标注进 pack.context 且不进 stdout 之外的身份区", async () => {
    const { pack } = await packWithGatePolicy(undefined);
    expect(pack.context.signal_provenance).toBeDefined();
    const sources = (pack.context as unknown as {
      signal_provenance: { signal: string; source: string }[]
    }).signal_provenance;
    // affected_paths 指向 .ts 源文件：production_code 同时被手填与推断命中
    expect(sources).toContainEqual({ signal: "production_code", source: "declared+inferred" });
  });

  it("门禁权威快照：工作副本的 DAG/validations 并入 v2 gate_policy content", async () => {
    const pythonPolicy = {
      schemaVersion: 1,
      tier: "standard",
      source: "default-standard",
      plannedPhases: ["plan", "execute", "submit", "archive"],
      requiredValidations: ["compile", "unitTest", "unitTestFull"],
      requiredValidationsByPhase: { execute: ["compile", "unitTest", "unitTestFull"] },
      requiredGateDag: {
        schemaVersion: 1,
        nodes: [{ id: "validation:compile", kind: "validation", dependsOn: [] }],
        edges: []
      }
    };
    const { pack } = await packWithGatePolicy(pythonPolicy);
    const gatePolicy = (pack.trusted as unknown as {
      machine: { gate_policy: { content: Record<string, unknown> } }
    }).machine.gate_policy;
    // 权威切换（2026-08）：v2 产物自带门禁字段，gate 无需再读工作副本
    expect(gatePolicy.content.tier).toBe("standard");
    expect(gatePolicy.content.source).toBe("default-standard");
    expect(gatePolicy.content.required_gate_dag).toEqual(pythonPolicy.requiredGateDag);
    expect(gatePolicy.content.required_validations_by_phase)
      .toEqual({ execute: ["compile", "unitTest", "unitTestFull"] });
    expect(gatePolicy.content.phase_set_source).toBe("gate-policy");
    // 白名单之外的 Python 字段不得混入身份内容
    expect(gatePolicy.content).not.toHaveProperty("classifiedAt");
  });

  it("旧契约 run/test validations 键并入时归一到 execute 取并集", async () => {
    const { pack } = await packWithGatePolicy({
      schemaVersion: 1,
      plannedPhases: ["plan", "run", "test", "archive"],
      requiredValidationsByPhase: { run: ["compile", "unitTest"], test: ["unitTestFull"] }
    });
    const gatePolicy = (pack.trusted as unknown as {
      machine: { gate_policy: { content: Record<string, unknown> } }
    }).machine.gate_policy;
    expect(gatePolicy.content.required_validations_by_phase)
      .toEqual({ execute: ["compile", "unitTest", "unitTestFull"] });
  });
});
