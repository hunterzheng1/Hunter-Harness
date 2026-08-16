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
});
