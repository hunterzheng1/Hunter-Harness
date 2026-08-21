import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PLAN_PHASES,
  classifyPlan,
  configurePlannedPhases,
  createPlanArtifactModel,
  createPlanDecisionModule,
  createPlanQualityModule,
  createPlanStageVerifier,
  createPlanningContextModule,
  planDurablePublicationTargetPaths,
  type ApprovalContentInput,
  type HumanArtifactBuildInput,
  type TrustedArtifactSetInput
} from "@hunter-harness/core";

import { runPlanFinalize } from "../src/commands/plan-finalize.js";
import { createPlanFinalizationRenderer } from "../src/plan-finalization/production-ports.js";

const now = "2026-08-16T10:00:00.000Z";
const sha = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as const;
const CHANGE_KEY = "e2e-finalize";
const dimensions = ["business_rules", "concurrency_idempotency", "data_compatibility", "error_codes",
  "integration_impact", "normal_path", "parameter_validation", "permission_boundaries"] as const;

function testHash(value: unknown): `sha256:${string}` {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]));
    }
    return input;
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function approvalContent(): ApprovalContentInput {
  return {
    goal: "端到端发布验证", user_visible_outcome: "结构化证据包完成发布", in_scope: ["plan_finalize"],
    out_of_scope: ["python_finalizer"], recommended_design: "三层收据驱动唯一发布意图",
    key_alternatives: ["继续依赖叙述式自检"], invariants: ["结构失败绝不发布"],
    failure_behaviors: ["结构失败绝不发布"], compatibility_boundaries: ["旧质量记录只读"],
    risks: [{ risk: "评审循环", mitigation: "委派失败最多一次 inline fallback" }],
    acceptance_examples: ["standard 执行语义层", "结构失败绝不发布", "发布证据闭合"]
  };
}

function humanInput(): HumanArtifactBuildInput {
  const profile = classifyPlan({ schema_version: 1, change_id: CHANGE_KEY,
    risk_signals: ["production_code", "cross_file"], created_at: now });
  const phase_set = configurePlannedPhases(profile, { schema_version: 1, is_git: true, has_remote: true,
    uses_worktree: false, available_phases: PLAN_PHASES, requested_optional_phases: [], requested_omissions: [],
    configured_at: now });
  const planning = createPlanningContextModule();
  const intent = planning.buildIntent({ schema_version: 1, source_input: "端到端发布验证", goal: approvalContent().goal,
    user_visible_outcome: approvalContent().user_visible_outcome, in_scope: approvalContent().in_scope,
    out_of_scope: approvalContent().out_of_scope, constraints: ["no_fs_write"],
    acceptance_examples: approvalContent().acceptance_examples, uncertainties: [], created_at: now });
  const evidence = planning.buildEvidenceMap({ schema_version: 1, map_manifest_hash: sha("a"), sources: [{
    source_kind: "map", source_id: "map:e2e", source_version: "v1", content_hash: sha("b"),
    module_refs: ["plan_finalize"], symbol_refs: ["runPlanFinalize"], consumer_refs: ["cli"],
    test_refs: ["plan-finalize-command.e2e.test.ts"], constraint_refs: ["no_fs_write"], unknown_refs: []
  }], budget: { max_sources: 2, max_refs: 16 }, created_at: now });
  const context = planning.buildPlanningContext({ profile, phase_set, intent, evidence,
    map_manifest_hash: sha("a"), created_at: now });
  const decision = createPlanDecisionModule();
  const graph = decision.evaluateDecisionGraph({ schema_version: 1, profile, phase_set, context, intent, evidence,
    nodes: [], evaluated_at: now });
  const approval_package_input = { content: approvalContent(), created_at: now };
  const approval_package = decision.buildApprovalPackage({ schema_version: 1, profile, phase_set, context, intent,
    evidence, graph, ...approval_package_input });
  const approval_receipt = decision.recordApproval({ package: approval_package, graph, profile, phase_set, context,
    intent, evidence, package_input: approval_package_input, outcome: "approved", approver_id: "user:owner",
    decided_at: now }).receipt;
  const scopeText = "plan_finalize";
  const scope_ref = `scope:${testHash({ text: scopeText }).slice(7)}`;
  const evidence_refs = ["module:plan_finalize", "symbol:runPlanFinalize"];
  const requirementSource = [{ kind: "behavior" as const, text: approvalContent().recommended_design },
    ...approvalContent().invariants.map((text) => ({ kind: "invariant" as const, text })),
    ...approvalContent().failure_behaviors.map((text) => ({ kind: "failure_behavior" as const, text }))];
  const requirements = requirementSource.map((item) => {
    const body = { ...item, evidence_refs, approved_scope_refs: [scope_ref] };
    return { requirement_id: `requirement:${testHash(body).slice(7)}`, ...body };
  });
  const requirement_refs = requirements.map((item) => item.requirement_id);
  const task_refs = ["task:e2e"];
  const scenarios = dimensions.map((dimension, index) => ({
    scenario_id: `scenario:${dimension}`,
    title: `场景 ${dimension}`,
    acceptance: "发布证据闭合",
    coverage_dimension: dimension,
    execution_level: (index === 0 ? "unit" : "integration") as "unit" | "integration",
    evidence_requirements: ["focused_test"],
    risk_level: "medium" as const,
    priority: "P1" as const,
    owner_phase: "run" as const,
    executable_test_id: `unit::${dimension}`,
    test_file: "tests/unit.spec.ts",
    test_title: `${dimension}`,
    task_refs,
    requirement_refs
  }));
  const coverage = dimensions.map((coverage_dimension) => ({
    coverage_dimension,
    applicability: "applicable" as const,
    scenario_refs: scenarios.filter((item) => item.coverage_dimension === coverage_dimension)
      .map((item) => item.scenario_id)
  }));
  const ownershipBody = { path: "packages/cli/src/commands/plan-finalize.ts", approved_scope_refs: [scope_ref],
    evidence_refs };
  const ownership = { ownership_ref: `ownership:${testHash(ownershipBody).slice(7)}`, ...ownershipBody };
  return {
    schema_version: 2, profile, phase_set, context, intent, evidence, graph, approval_package,
    approval_package_input, approval_receipt,
    structured_input: {
      change_key: CHANGE_KEY,
      tasks: [{
        task_id: "task:e2e", objective: "端到端发布", affected_paths: ["packages/cli/src/commands/plan-finalize.ts"],
        depends_on: [], owner_phase: "run", decision_refs: [],
        scenario_refs: scenarios.map((item) => item.scenario_id),
        requirement_refs, evidence_refs, ownership_refs: [ownership.ownership_ref]
      }],
      scenarios, coverage, requirements,
      approved_scopes: [{ scope_ref, text: scopeText }], ownership: [ownership]
    }
  };
}

function trusted(): TrustedArtifactSetInput {
  const input = humanInput();
  const model = createPlanArtifactModel();
  const human = model.buildHumanArtifacts(input);
  const machine_input = { schema_version: 2 as const, profile: input.profile, phase_set: input.phase_set,
    capabilities: ["api"] as const, worktree_policy: "project_default" as const };
  const machine = model.deriveMachineArtifacts({ ...machine_input, human_input: input, human });
  const detail = model.deriveImplementationDetail({ mode: "standard", human_input: input, human });
  return { human_input: input, human, machine_input, machine, detail };
}

function renderedIntent(value: TrustedArtifactSetInput): string {
  const renderer = createPlanFinalizationRenderer();
  const plan = renderer.render({
    schema_version: 1,
    context: { change_key: CHANGE_KEY } as never,
    finalization: { quality_verification_input: { trusted: value } } as never
  }) as { publication_intent_id: string };
  return plan.publication_intent_id;
}

function publicationEvidence(value: TrustedArtifactSetInput) {
  const source = [
    ["design.md", value.human.design],
    ["gate-policy.json", value.machine.gate_policy],
    ["implementation-checkpoints.json", value.machine.implementation_checkpoints],
    ["implementation-detail.md", value.detail],
    ["plan.md", value.human.plan],
    ["scenario-manifest.json", value.machine.scenario_manifest],
    ["test-scenarios.md", value.human.test_scenarios],
    ["worktree.json", value.machine.worktree]
  ] as const;
  const files = source.map(([path, artifact]) => {
    const format = path.endsWith(".md") ? "markdown" as const : "json" as const;
    const body = JSON.stringify(artifact);
    const serialized_content = format === "markdown"
      ? `---\nschema_version: 2\nartifact_type: ${artifact.artifact_type}\ncontent_hash: ${artifact.content_hash}\n---\n${body}`
      : body;
    return { path, serialized_content, serialized_hash: testHash(serialized_content), format };
  });
  return {
    schema_version: 1 as const,
    stage_id: "stage:e2e",
    publication_intent_id: renderedIntent(value),
    files,
    ownership_paths: ["packages/cli/src/commands/plan-finalize.ts"],
    approval_receipt_ref: value.human_input.approval_receipt.receipt_id,
    artifact_derivation_receipt_refs: [
      value.human.artifact_set_hash,
      value.machine.artifact_set_hash,
      value.detail.content_hash
    ]
  };
}

describe("hunter-harness plan finalize (e2e)", () => {
  let root: string;
  let inputPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "harness-plan-finalize-"));
    await fs.mkdir(join(root, ".harness", "changes", CHANGE_KEY), { recursive: true });
    const trustedValue = trusted();
    inputPath = join(root, "evidence.json");
    await fs.writeFile(inputPath, JSON.stringify({
      trusted: trustedValue,
      publication: publicationEvidence(trustedValue),
      context: {
        project_id: "prj_e2e",
        change_key: CHANGE_KEY,
        run_id: "run_e2e01",
        branch_name: "main",
        attempt: 1
      },
      expected_baseline: { state: "absent", manifest_hash: null, generation: 0 }
    }));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });


  it("probe quality layers", () => {
    const trustedValue = trusted();
    const publication = publicationEvidence(trustedValue);
    const quality = createPlanQualityModule();
    const verifier = createPlanStageVerifier({ now: () => now });
    const layer1 = quality.runDeterministicGates({ trusted: trustedValue, publication,
      stage_verifier_port: verifier, completed_at: now });
    const layer2 = quality.runSemanticGates({ trusted: trustedValue, completed_at: now });
    const layer3 = quality.runAdversarialGates({ trusted: trustedValue, semantic: layer2,
      explicit_adversarial: false, prefer_delegated: false, completed_at: now });
    const finalized = quality.finalizeQuality({ trusted: trustedValue, layer1, layer2, layer3,
      trusted_stage_verification: layer1.stage_verification,
      trusted_semantic_projection: { input_hash: layer2.input_hash, evaluator_invoked: layer2.evaluator_invoked,
        findings: layer2.findings, status: layer2.status, completed_at: layer2.completed_at },
      trusted_review_execution: layer3.review_execution, publication,
      run_id: "run_e2e01", attempt: 1, phase: "plan", completed_at: now });
    expect(layer1.status).toBe("passed");
    expect(finalized.receipt.receipt_id.length).toBeGreaterThan(0);
    expect(finalized.events.length).toBeGreaterThan(0);
  });

  it("runs the full v2 chain: gates → finalize → FS publication → event outbox", async () => {
    const outputs: string[] = [];
    const exitCode = await runPlanFinalize({ input: inputPath }, {
      cwd: root,
      stdout: (chunk: string) => { outputs.push(chunk); return true; },
      stderr: () => true
    });

    if (exitCode !== 0) console.error("CMD-OUT:", outputs.join(""));
    expect(exitCode).toBe(0);
    const result = JSON.parse(outputs.join("")) as {
      ok: boolean; code: string; status: string; event_outbox_id: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.code).toBe("PLAN_FINALIZED");

    for (const path of planDurablePublicationTargetPaths(CHANGE_KEY)) {
      await fs.access(join(root, ".harness", "changes", CHANGE_KEY, path));
    }
    const ndjson = await fs.readFile(
      join(root, ".harness", "changes", CHANGE_KEY, "meta", "plan-events.ndjson"), "utf8");
    const eventTypes = ndjson.trim().split("\n").map((line) => (JSON.parse(line) as { type: string }).type);
    expect(eventTypes).toContain("artifact_published");
    expect(eventTypes).toContain("phase_ended");
  });

  it("v2 发布之后 Python 门禁仍然开得了门", async () => {
    // 这条是本轮的真正验收：TS 的 e2e 从不调 Python，Python 的 v2 夹具是手写假产物，
    // 于是"发布覆盖门禁文件"这类碰撞可以无声进入默认路径。这里跑真实链路——
    // classify 写策略 → v2 finalize 发布八 target → gate begin --phase run。
    const changeDir = join(root, ".harness", "changes", CHANGE_KEY);
    const { fileURLToPath } = await import("node:url");
    const scriptsDir = fileURLToPath(new URL("../../../harness/scripts/", import.meta.url));
    const contracts = fileURLToPath(new URL("../../../harness/contracts/workflow-policy.json",
      import.meta.url));
    const { spawnSync } = await import("node:child_process");

    // 阶段 0.5 等价物：真实 classify 落 meta/gate-policy.json
    await fs.mkdir(join(root, "harness", "contracts"), { recursive: true });
    await fs.copyFile(contracts, join(root, "harness", "contracts", "workflow-policy.json"));
    const classify = spawnSync("python", [join(scriptsDir, "harness_gate.py"), "classify",
      "--project", root, "--change", CHANGE_KEY, "--stage", "plan", "--json"],
      { cwd: root, encoding: "utf8" });
    expect(classify.status, classify.stderr).toBe(0);

    // 阶段 8：v2 finalize 发布八 target
    const outputs: string[] = [];
    expect(await runPlanFinalize({ input: inputPath }, {
      cwd: root,
      stdout: (chunk: string) => { outputs.push(chunk); return true; },
      stderr: () => true
    })).toBe(0);

    // 发布后 Python 侧读策略必须仍然成立——这一步以前会 POLICY_LOAD_FAILED。
    const probe = [
      "import importlib.util, json, sys",
      `spec = importlib.util.spec_from_file_location('hg', ${JSON.stringify(join(scriptsDir, "harness_gate.py"))})`,
      "m = importlib.util.module_from_spec(spec); sys.modules['hg'] = m; spec.loader.exec_module(m)",
      "from pathlib import Path",
      `cd = Path(${JSON.stringify(changeDir)})`,
      `policy = m._load_workflow_policy(project=Path(${JSON.stringify(root)}))`,
      "eff = m.effective_workflow_policy(policy, cd)",
      "print(json.dumps({'ok': True, 'run': eff['requiredValidations'].get('run')}))"
    ].join("\n");
    const run = spawnSync("python", ["-c", probe], { cwd: root, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect((JSON.parse(run.stdout) as { ok: boolean }).ok).toBe(true);
  });

  it("发布不覆盖 Python 写的 meta/gate-policy.json", async () => {
    // v2 finalize 对 binding.ownership_paths 逐个 writeFileAtomic——不读旧内容、不合并。
    // 阶段 0.5 的 classify 已经把 gate-policy 写成 Python 形状（schemaVersion:1 +
    // requiredGateDag），阶段 8 若把它换成 TS 的 artifact 包装体，run 阶段开门时
    // harness_gate 读 schemaVersion 拿到 None 就 raise，整条工作流卡死。
    const changeDir = join(root, ".harness", "changes", CHANGE_KEY);
    const policyPath = join(changeDir, "meta", "gate-policy.json");
    await fs.mkdir(join(changeDir, "meta"), { recursive: true });
    const pythonPolicy = {
      schemaVersion: 1,
      tier: "standard",
      source: "default-standard",
      defaultPhases: ["plan", "run", "test", "submit", "archive"],
      requiredValidations: ["compile", "unitTest", "unitTestFull"],
      requiredValidationsByPhase: { run: ["compile", "unitTest"], test: ["unitTestFull"] },
      requiredGateDag: { schemaVersion: 1, nodes: [], edges: [] }
    };
    await fs.writeFile(policyPath, JSON.stringify(pythonPolicy), "utf8");

    const outputs: string[] = [];
    const exitCode = await runPlanFinalize({ input: inputPath }, {
      cwd: root,
      stdout: (chunk: string) => { outputs.push(chunk); return true; },
      stderr: () => true
    });
    expect(exitCode).toBe(0);

    const after = JSON.parse(await fs.readFile(policyPath, "utf8")) as Record<string, unknown>;
    // Python 是 gate-policy 的权威写者；TS 那份是派生视图，不该占用这个文件名。
    expect(after.schemaVersion, "gate-policy 被 v2 发布覆盖了").toBe(1);
    expect(after).toHaveProperty("requiredGateDag");
    expect(after).not.toHaveProperty("artifact_type");
  });

  it("发布的 implementation-checkpoints 不让 foundation-gate 失效", async () => {
    // Python 的 checkpoint_status 找 checkpoints[] 数组；找不到就返回 "missing"，
    // foundation_gate_blocks 随即放行——对所有 v2 计划静默关掉这道门。
    const outputs: string[] = [];
    const exitCode = await runPlanFinalize({ input: inputPath }, {
      cwd: root,
      stdout: (chunk: string) => { outputs.push(chunk); return true; },
      stderr: () => true
    });
    expect(exitCode).toBe(0);

    const checkpointsPath = join(root, ".harness", "changes", CHANGE_KEY,
      "meta", "implementation-checkpoints.json");
    const { fileURLToPath } = await import("node:url");
    const gatePath = fileURLToPath(
      new URL("../../../harness/scripts/harness_gate.py", import.meta.url));
    const probe = [
      "import importlib.util, json, sys",
      `spec = importlib.util.spec_from_file_location('hg', ${JSON.stringify(gatePath)})`,
      "m = importlib.util.module_from_spec(spec); sys.modules['hg'] = m; spec.loader.exec_module(m)",
      "from pathlib import Path",
      `cps = m.load_checkpoints(Path(${JSON.stringify(join(root, ".harness", "changes", CHANGE_KEY))}))`,
      "print(json.dumps(m.checkpoint_status(cps, 'foundation-gate')))"
    ].join("\n");
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync("python", ["-c", probe], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);

    await fs.access(checkpointsPath);
    const status = JSON.parse(run.stdout) as string;
    // v2 的 content.foundation_gate 是 "approved"，Python 必须看得见它——
    // "missing" 意味着这道门对整条 v2 路径是关的。
    expect(status, "foundation-gate 对 v2 计划静默失效").not.toBe("missing");
  });

  it("发布的 scenario-manifest 能被 Python 门禁解包消费", async () => {
    // 这条补的是双语言之间的缺口：Python 侧的 v2 夹具是手写 JSON，生产端字段一变
    // 它不会失效。这里拿**真实 finalize 产出的**那份 manifest 去喂真实的解包器，
    // 任一边改了键名都会在这里立刻red。
    const outputs: string[] = [];
    const exitCode = await runPlanFinalize({ input: inputPath }, {
      cwd: root,
      stdout: (chunk: string) => { outputs.push(chunk); return true; },
      stderr: () => true
    });
    expect(exitCode).toBe(0);

    const manifestPath = join(root, ".harness", "changes", CHANGE_KEY,
      "meta", "scenario-manifest.json");
    // 从测试文件本身定位，不依赖 cwd（vitest 从仓库根跑，不是 packages/cli）。
    const { fileURLToPath } = await import("node:url");
    const finalizerPath = fileURLToPath(
      new URL("../../../harness/scripts/harness_plan_finalize.py", import.meta.url));
    const probe = [
      "import importlib.util, json, sys",
      `spec = importlib.util.spec_from_file_location('hpf', ${JSON.stringify(finalizerPath)})`,
      "m = importlib.util.module_from_spec(spec); sys.modules['hpf'] = m; spec.loader.exec_module(m)",
      `manifest = json.load(open(${JSON.stringify(manifestPath)}, encoding='utf-8-sig'))`,
      "print(json.dumps(m.unpack_v2_scenario_manifest(manifest)))"
    ].join("\n");

    const { spawnSync } = await import("node:child_process");
    const run = spawnSync("python", ["-c", probe], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);

    const unpacked = JSON.parse(run.stdout) as {
      ok: boolean;
      manifest?: { schemaVersion: number; scenarios: Record<string, unknown>[] };
      missingFields?: string[];
    };
    expect(unpacked.missingFields ?? [], "门禁仍认为字段有缺口").toEqual([]);
    expect(unpacked.ok).toBe(true);
    // 可执行三元齐全 → schemaVersion 2，关门时才能绑结构化执行收据。
    expect(unpacked.manifest?.schemaVersion).toBe(2);
    const first = unpacked.manifest?.scenarios[0] ?? {};
    for (const key of ["id", "priority", "requiredEvidenceKind", "ownerPhase",
      "executableTestId", "testFile", "testTitle"]) {
      expect(first, `解包结果缺 ${key}`).toHaveProperty(key);
    }
  });

  it("HP-10：--change-dir 真实参与路径解析", async () => {
    const changeDir = join(root, ".harness", "changes", CHANGE_KEY);
    const deps = (outputs: string[]) => ({
      cwd: join(root, "elsewhere"),
      stdout: (chunk: string) => { outputs.push(chunk); return true; },
      stderr: () => true
    });
    await fs.mkdir(join(root, "elsewhere"), { recursive: true });

    // 形状错误（basename 与 change_key 不符）
    const badOut: string[] = [];
    const badExit = await runPlanFinalize({ input: inputPath, changeDir: join(root, "wrong") }, deps(badOut));
    expect(badExit).toBe(1);
    expect(JSON.parse(badOut.join("")).code).toBe("PLAN_CHANGE_DIR_INVALID");

    // 正确绝对路径：从非根 cwd 运行，目标只写入指定 change
    const goodOut: string[] = [];
    const goodExit = await runPlanFinalize({ input: inputPath, changeDir }, deps(goodOut));
    if (goodExit !== 0) console.error("CD-OUT:", goodOut.join(""));
    expect(goodExit).toBe(0);
    for (const path of planDurablePublicationTargetPaths(CHANGE_KEY)) {
      await fs.access(join(changeDir, path));
    }
  });

  it("HP-09：finalize 成功向 legacy events.ndjson 幂等投影 plan 终态", async () => {
    const changeDir = join(root, ".harness", "changes", CHANGE_KEY);
    const eventsPath = join(changeDir, "events.ndjson");
    // 种子：一个打开的 plan attempt（phase.start 无终端）
    await fs.writeFile(eventsPath, JSON.stringify({
      schema_version: 3,
      id: "evt-seed",
      timestamp: "2026-08-16T09:00:00.000Z",
      phase: "plan",
      type: "phase.start",
      run_id: "run_e2e01",
      attempt: 1
    }) + "\n");

    const deps = (outputs: string[]) => ({
      cwd: root,
      stdout: (chunk: string) => { outputs.push(chunk); return true; },
      stderr: () => true
    });
    const firstOut: string[] = [];
    expect(await runPlanFinalize({ input: inputPath }, deps(firstOut))).toBe(0);
    const first = JSON.parse(firstOut.join("")) as { legacy_lifecycle_projection?: string };
    expect(first.legacy_lifecycle_projection).toBe("closed_open_attempt");
    const afterFirst = (await fs.readFile(eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; run_id?: string; attempt?: number });
    const terminals = afterFirst.filter((event) =>
      event.type === "phase.end" && event.run_id === "run_e2e01" && event.attempt === 1);
    expect(terminals).toHaveLength(1);

    // 幂等：重复执行不再产生第二个终态
    const secondOut: string[] = [];
    expect(await runPlanFinalize({ input: inputPath }, deps(secondOut))).toBe(0);
    const second = JSON.parse(secondOut.join("")) as { legacy_lifecycle_projection?: string };
    expect(second.legacy_lifecycle_projection).toBe("already_closed");
    const afterSecond = (await fs.readFile(eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; run_id?: string; attempt?: number });
    expect(afterSecond.filter((event) =>
      event.type === "phase.end" && event.run_id === "run_e2e01" && event.attempt === 1)).toHaveLength(1);
  });
});
