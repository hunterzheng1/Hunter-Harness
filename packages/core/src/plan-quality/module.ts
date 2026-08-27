import { isProxy } from "node:util/types";

import { readPlanEventBundle } from "@hunter-harness/contracts";
import { createPlanArtifactModel } from "../plan-artifacts/index.js";
import { PLAN_PHASES } from "../plan-classification/index.js";
import { PlanQualityError } from "./errors.js";
import { cp, exact, freeze, hash, path, record, snapshot, strings, text, time } from "./stable.js";
import type { AdversarialReviewerPort, Layer1Receipt, Layer2Receipt, Layer3Receipt, LensAssessment,
  PlanEvent, PlanFinalizationReceipt, PlanQualityModule, QualityFinding, QualityLens,
  ReviewExecutionReceipt, StagedPublicationEvidence, StageVerificationEvidence, TrustedArtifactSetInput } from "./types.js";

const sha = /^sha256:[0-9a-f]{64}$/u;
const identity = /^[a-z][a-z0-9_.:-]{0,159}$/u;
const requiredPaths = ["design.md", "gate-policy.json", "implementation-checkpoints.json", "implementation-detail.md",
  "plan.md", "scenario-manifest.json", "test-scenarios.md", "worktree.json"] as const;
const allLenses: readonly QualityLens[] = ["concurrency_retry", "data_consistency", "dependency_seam", "failure_modes",
  "interface_contract", "migration_rollback", "observability", "security_audit", "user_behavior"];

function fail(code: PlanQualityError["code"]): never { throw new PlanQualityError(code); }
function snap<T>(input: unknown): T { try { return snapshot(input) as T; } catch { return fail("PLAN_QUALITY_INPUT_INVALID"); } }
function withPort<T>(input: unknown, required: readonly string[], portKey: string, method: string): T {
  try {
    if (isProxy(input) || !record(input) || !exact(input, required, [portKey])) {
      return fail("PLAN_QUALITY_INPUT_INVALID");
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol") || Object.values(descriptors).some((descriptor) =>
      !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable)) {
      return fail("PLAN_QUALITY_INPUT_INVALID");
    }
    const rawPort = descriptors[portKey]?.value as unknown;
    const data = Object.fromEntries(Object.entries(descriptors).filter(([key]) => key !== portKey)
      .map(([key, descriptor]) => [key, descriptor.value]));
    const safe = snap<Record<string, unknown>>(data);
    if (rawPort !== undefined) {
      if (isProxy(rawPort) || !record(rawPort) || !exact(rawPort, [method]) ||
        typeof Object.getOwnPropertyDescriptor(rawPort, method)?.value !== "function") {
        return fail("PLAN_QUALITY_INPUT_INVALID");
      }
      safe[portKey] = rawPort;
    }
    return safe as T;
  } catch { return fail("PLAN_QUALITY_INPUT_INVALID"); }
}
function same(a: unknown, b: unknown): boolean { return hash(a) === hash(b); }
function receipt<T extends Record<string, unknown>>(kind: string, body: T): T & { receipt_hash: string; receipt_id: string } {
  const receipt_hash = hash(body); return freeze({ ...body, receipt_hash,
    receipt_id: `plan_quality:${kind}:${receipt_hash.slice("sha256:".length)}` });
}
function receiptClosed(value: Record<string, unknown>, kind: string): boolean {
  const receiptHash = value.receipt_hash;
  if (typeof receiptHash !== "string" || !sha.test(receiptHash) ||
    value.receipt_id !== `plan_quality:${kind}:${receiptHash.slice("sha256:".length)}`) return false;
  const { receipt_hash: ignoredHash, receipt_id: ignoredId, ...body } = value;
  void ignoredHash; void ignoredId;
  return receiptHash === hash(body);
}

function trusted(value: TrustedArtifactSetInput): TrustedArtifactSetInput {
  if (!record(value) || !exact(value, ["human_input", "human", "machine_input", "machine", "detail"])) {
    return fail("PLAN_QUALITY_TRUST_INVALID");
  }
  const verification = createPlanArtifactModel().verifyArtifactSet(value);
  if (!verification.valid) return fail("PLAN_QUALITY_TRUST_INVALID");
  return value;
}

function validFinding(value: unknown): value is QualityFinding {
  return record(value) && exact(value, ["finding_id", "category", "severity", "source_refs", "message_zh",
    "suggested_location"]) && text(value.finding_id, 160) && identity.test(value.finding_id) && text(value.category, 128) &&
    (value.severity === "advisory" || value.severity === "blocking") && strings(value.source_refs, 1, 32) &&
    text(value.message_zh, 2_048) && typeof value.suggested_location === "string" && path(value.suggested_location);
}
function findings(value: unknown): readonly QualityFinding[] {
  if (!Array.isArray(value) || value.length > 128 || !value.every(validFinding)) return fail("PLAN_QUALITY_INPUT_INVALID");
  const sorted = [...value].sort((a, b) => cp(a.finding_id, b.finding_id));
  if (new Set(sorted.map((item) => item.finding_id)).size !== sorted.length) return fail("PLAN_QUALITY_INPUT_INVALID");
  return sorted;
}

function reviewerResult(value: unknown): { readonly reviewer_identity: string; readonly findings: readonly QualityFinding[] } | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || !exact(value, ["reviewer_identity", "findings"]) ||
    !text(value.reviewer_identity, 160) || !identity.test(value.reviewer_identity)) return fail("PLAN_QUALITY_INPUT_INVALID");
  return { reviewer_identity: value.reviewer_identity, findings: findings(value.findings) };
}

function expectedFiles(value: TrustedArtifactSetInput): readonly { path: string; artifact: unknown }[] {
  return [
    { path: "design.md", artifact: value.human.design },
    { path: "gate-policy.json", artifact: value.machine.gate_policy },
    { path: "implementation-checkpoints.json", artifact: value.machine.implementation_checkpoints },
    { path: "implementation-detail.md", artifact: value.detail },
    { path: "plan.md", artifact: value.human.plan },
    { path: "scenario-manifest.json", artifact: value.machine.scenario_manifest },
    { path: "test-scenarios.md", artifact: value.human.test_scenarios },
    { path: "worktree.json", artifact: value.machine.worktree }
  ];
}

function validPublication(value: StagedPublicationEvidence): boolean {
  if (!record(value) || !exact(value, ["schema_version", "stage_id", "publication_intent_id", "files",
    "ownership_paths", "approval_receipt_ref", "artifact_derivation_receipt_refs"]) ||
    value.schema_version !== 1 || !text(value.stage_id, 160) || !identity.test(value.stage_id) ||
    !text(value.publication_intent_id, 160) ||
    !identity.test(value.publication_intent_id) || !Array.isArray(value.files) ||
    value.files.length !== requiredPaths.length || !value.files.every((file) => record(file) &&
      exact(file, ["path", "serialized_content", "serialized_hash", "format"]) &&
      typeof file.path === "string" && path(file.path) &&
      text(file.serialized_content, 1_000_000) && typeof file.serialized_hash === "string" && sha.test(file.serialized_hash) &&
      file.serialized_hash === hash(file.serialized_content) && (file.format === "markdown" || file.format === "json")) ||
    !same(value.files.map((file) => file.path), requiredPaths) || value.files.some((file) =>
      file.format !== (file.path.endsWith(".md") ? "markdown" : "json")) ||
    !strings(value.ownership_paths, 1, 256) || !value.ownership_paths.every(path) ||
    !text(value.approval_receipt_ref, 256) || !strings(value.artifact_derivation_receipt_refs, 3, 3) ||
    !value.artifact_derivation_receipt_refs.every((ref) => sha.test(ref))) return false;
  return true;
}

function expectedContentHashes(artifacts: TrustedArtifactSetInput): Readonly<Record<string, string>> {
  return freeze(Object.fromEntries(expectedFiles(artifacts).map(({ path: filePath, artifact }) =>
    [filePath, (artifact as { readonly content_hash: string }).content_hash])));
}

function stageVerificationInput(publication: StagedPublicationEvidence, artifacts: TrustedArtifactSetInput) {
  const files_hash = hash(publication.files); const expected_content_hashes = expectedContentHashes(artifacts);
  const body = { stage_id: publication.stage_id, publication_intent_id: publication.publication_intent_id,
    files_hash, files: publication.files, expected_content_hashes,
    approval_receipt_ref: publication.approval_receipt_ref,
    artifact_derivation_receipt_refs: publication.artifact_derivation_receipt_refs };
  return freeze({ ...body, input_hash: hash(body) });
}

function validateStageEvidence(value: unknown, expected: ReturnType<typeof stageVerificationInput>):
StageVerificationEvidence {
  if (!record(value) || !exact(value, ["schema_version", "stage_id", "input_hash", "files_hash", "content_hashes",
    "approval_receipt_ref", "artifact_derivation_receipt_refs", "atomic_publish_receipt", "readback_hash",
    "verified_at", "evidence_hash"]) || value.schema_version !== 1 || value.stage_id !== expected.stage_id ||
    value.input_hash !== expected.input_hash || value.files_hash !== expected.files_hash ||
    !same(value.content_hashes, expected.expected_content_hashes) ||
    value.approval_receipt_ref !== expected.approval_receipt_ref ||
    !same(value.artifact_derivation_receipt_refs, expected.artifact_derivation_receipt_refs) ||
    typeof value.atomic_publish_receipt !== "string" || !sha.test(value.atomic_publish_receipt) ||
    value.readback_hash !== expected.files_hash || !time(value.verified_at) || typeof value.evidence_hash !== "string" ||
    !sha.test(value.evidence_hash)) return fail("PLAN_QUALITY_INPUT_INVALID");
  const { evidence_hash, ...body } = value;
  if (evidence_hash !== hash(body)) return fail("PLAN_QUALITY_INPUT_INVALID");
  return value as unknown as StageVerificationEvidence;
}

function parseStagedFile(file: StagedPublicationEvidence["files"][number]): unknown {
  if (file.format === "json") return JSON.parse(file.serialized_content);
  const lines = file.serialized_content.split("\n");
  if (lines.length < 6 || lines[0] !== "---" || lines[4] !== "---" ||
    lines[1] !== "schema_version: 2" || !lines[2]?.startsWith("artifact_type: ") ||
    !lines[3]?.startsWith("content_hash: sha256:")) throw new Error("invalid_frontmatter");
  const artifact = JSON.parse(lines.slice(5).join("\n")) as unknown;
  if (!record(artifact) || artifact.schema_version !== 2 ||
    lines[2] !== `artifact_type: ${String(artifact.artifact_type)}` ||
    lines[3] !== `content_hash: ${String(artifact.content_hash)}`) throw new Error("frontmatter_mismatch");
  return artifact;
}

function deterministicWithEvidence(artifacts: TrustedArtifactSetInput, publication: StagedPublicationEvidence,
  stageVerification: StageVerificationEvidence, completedAt: string): Layer1Receipt {
  const expectedStage = stageVerificationInput(publication, artifacts);
  validateStageEvidence(stageVerification, expectedStage);
  const expected = expectedFiles(artifacts); const parsed: { path: string; artifact: unknown }[] = [];
  const owned = [...new Set(artifacts.human.plan.content.tasks.flatMap((task) => task.affected_paths))].sort(cp);
  const issues: QualityFinding[] = [];
  const add = (id: string, message: string, location: string): void => { issues.push({ finding_id: id,
    category: "deterministic", severity: "blocking", source_refs: [location], message_zh: message,
    suggested_location: location }); };
  for (const file of publication.files) {
    try { parsed.push({ path: file.path, artifact: parseStagedFile(file) }); }
    catch { add("deterministic.parse", "暂存产物无法解析", file.path); }
  }
  if (!same(parsed, expected)) add("deterministic.file_set", "发布文件集合或内容与可信产物不一致", "plan.md");
  if (!same([...publication.ownership_paths].sort(cp), owned)) add("deterministic.ownership", "修改路径未被计划任务完整覆盖", "plan.md");
  const publishedText = publication.files.map((file) => file.serialized_content).join("\n");
  const trustedText = JSON.stringify({ design: artifacts.human.design.content, plan: artifacts.human.plan.content,
    scenarios: artifacts.human.test_scenarios.content, detail: artifacts.detail.content,
    gate_policy: artifacts.machine.gate_policy, worktree: artifacts.machine.worktree,
    implementation_checkpoints: artifacts.machine.implementation_checkpoints,
    scenario_manifest: artifacts.machine.scenario_manifest });
  if (/\b(?:TODO|TBD|FIXME|PLACEHOLDER)\b|待补充/u.test(`${trustedText}\n${publishedText}`)) {
    add("deterministic.placeholder", "规划产物包含禁止占位符", "plan.md");
  }
  const body = { schema_version: 1 as const, layer: "deterministic" as const,
    status: issues.length === 0 ? "passed" as const : "failed" as const,
    artifact_set_hash: hash(artifacts), publication_evidence_hash: hash(publication),
    publication_intent_id: publication.publication_intent_id, stage_verification: stageVerification,
    findings: issues.sort((a, b) => cp(a.finding_id, b.finding_id)), completed_at: completedAt };
  return receipt("layer1", body);
}

function deterministic(input: Parameters<PlanQualityModule["runDeterministicGates"]>[0]): Layer1Receipt {
  if (!record(input) || !exact(input, ["trusted", "publication", "stage_verifier_port", "completed_at"]) ||
    !time(input.completed_at)) {
    return fail("PLAN_QUALITY_INPUT_INVALID");
  }
  const artifacts = trusted(input.trusted);
  const expectedDerivationRefs = [artifacts.human.artifact_set_hash, artifacts.machine.artifact_set_hash,
    artifacts.detail.content_hash];
  if (!validPublication(input.publication) ||
    input.publication.approval_receipt_ref !== artifacts.human_input.approval_receipt.receipt_id ||
    !same(input.publication.artifact_derivation_receipt_refs, expectedDerivationRefs)) {
    return fail("PLAN_QUALITY_INPUT_INVALID");
  }
  const expectedStage = stageVerificationInput(input.publication, artifacts);
  let stageEvidence: unknown;
  try { stageEvidence = snap(input.stage_verifier_port.verify(expectedStage)); }
  catch { return fail("PLAN_QUALITY_INPUT_INVALID"); }
  return deterministicWithEvidence(artifacts, input.publication,
    validateStageEvidence(stageEvidence, expectedStage), input.completed_at);
}

function semanticProjection(artifacts: TrustedArtifactSetInput): { readonly approved_decisions: readonly string[];
  readonly rejected_alternatives: readonly string[]; readonly findings: readonly QualityFinding[] } {
  const design = artifacts.human.design.content; const tasks = artifacts.human.plan.content.tasks;
  const scenarios = artifacts.human.test_scenarios.content.scenarios; const issues: QualityFinding[] = [];
  const add = (id: string, category: string, message: string, location: string, refs: readonly string[]): void => {
    issues.push({ finding_id: id, category, severity: "blocking", source_refs: refs,
      message_zh: message, suggested_location: location });
  };
  if (design.goal !== artifacts.human_input.intent.goal || design.user_visible_outcome !==
    artifacts.human_input.intent.user_visible_outcome) add("semantic.goal_coverage", "goal_coverage",
    "设计未覆盖批准的目标或用户可见结果", "design.md", ["design.md", "intent_contract"]);
  // HP-04：集合语义比较（顺序差异不再是语义差异）
  if (!same([...design.in_scope].sort(), [...artifacts.human_input.intent.in_scope].sort()) ||
    !same([...design.out_of_scope].sort(), [...artifacts.human_input.intent.out_of_scope].sort())) add("semantic.scope_identity", "scope",
    "设计范围与批准 Intent 不一致", "design.md", ["design.md", "intent_contract"]);
  const requirements = design.requirements; const ownership = design.ownership;
  const taskIds = tasks.map((task) => task.task_id); const scenarioIds = scenarios.map((scenario) => scenario.scenario_id);
  for (const requirement of requirements) {
    const implementingTasks = tasks.filter((task) => task.requirement_refs.includes(requirement.requirement_id));
    const acceptingScenarios = scenarios.filter((scenario) => scenario.requirement_refs.includes(requirement.requirement_id));
    if (implementingTasks.length === 0 || acceptingScenarios.length === 0 || acceptingScenarios.some((scenario) =>
      !scenario.task_refs.some((taskRef) => implementingTasks.some((task) => task.task_id === taskRef)))) {
      add(`semantic.requirement.${hash(requirement.requirement_id).slice(7, 19)}`, "requirement_coverage",
        "批准需求缺少关联任务或验收场景", "plan.md", [requirement.requirement_id, "plan.md", "test-scenarios.md"]);
    }
  }
  for (const task of tasks) {
    const reciprocal = scenarios.filter((scenario) => scenario.task_refs.includes(task.task_id))
      .map((scenario) => scenario.scenario_id).sort(cp);
    if (!same([...task.scenario_refs].sort(cp), reciprocal)) add(`semantic.task_link.${hash(task.task_id).slice(7, 19)}`,
      "reference_closure", "任务与场景引用未形成双向闭包", "plan.md", [task.task_id, ...task.scenario_refs]);
    for (const affectedPath of task.affected_paths) {
      const owner = ownership.find((item) => item.path === affectedPath && task.ownership_refs.includes(item.ownership_ref));
      if (owner === undefined || !task.evidence_refs.every((ref) => owner.evidence_refs.includes(ref)) ||
        owner.approved_scope_refs.some((ref) => !design.approved_scopes.some((scope) => scope.scope_ref === ref))) {
        add(`semantic.ownership.${hash(affectedPath).slice(7, 19)}`, "ownership_evidence",
          "受影响路径缺少批准的 ownership 或 evidence 绑定", "plan.md", [task.task_id, affectedPath]);
      }
    }
  }
  for (const scenario of scenarios) if (scenario.task_refs.some((ref) => !taskIds.includes(ref)) ||
    scenario.requirement_refs.some((requirementRef) => !scenario.task_refs.some((taskRef) =>
      tasks.find((task) => task.task_id === taskRef)?.requirement_refs.includes(requirementRef)))) {
    add(`semantic.scenario_link.${hash(scenario.scenario_id).slice(7, 19)}`, "reference_closure",
      "场景引用未由关联任务实现", "test-scenarios.md", [scenario.scenario_id, ...scenario.task_refs]);
  }
  if (new Set(scenarioIds).size !== scenarioIds.length) add("semantic.scenario_identity", "reference_closure",
    "场景标识不唯一", "test-scenarios.md", ["test-scenarios.md"]);
  const explicitlyRejected = artifacts.human_input.graph.nodes.filter((node) => node.status === "resolved" &&
    node.resolved_by === "user" && node.resolution === "rejected" && tasks.some((task) =>
    task.decision_refs.includes(node.decision_id))).map((node) => node.decision_id).sort(cp);
  for (const decisionId of explicitlyRejected) add(`semantic.rejected.${hash(decisionId).slice(7, 19)}`,
    "rejected_alternative", "用户已拒绝的方案仍被计划任务引用", "plan.md",
    [decisionId, "approval_package", "plan.md"]);
  const approved = artifacts.human_input.graph.nodes.filter((node) => node.status === "resolved" && node.resolution !== undefined)
    .map((node) => `${node.decision_id}:${node.resolution}`).sort(cp);
  return freeze({ approved_decisions: approved, rejected_alternatives: explicitlyRejected,
    findings: issues.sort((a, b) => cp(a.finding_id, b.finding_id)) });
}

function semantic(input: Parameters<PlanQualityModule["runSemanticGates"]>[0]): Layer2Receipt {
  if (!record(input) || !exact(input, ["trusted", "completed_at"], ["evaluator_port"]) || !time(input.completed_at)) {
    return fail("PLAN_QUALITY_INPUT_INVALID");
  }
  const artifacts = trusted(input.trusted); const profile = artifacts.human_input.profile;
  const projection = semanticProjection(artifacts);
  const input_hash = semanticInputHash(artifacts, projection);
  if (profile.mode === "quick") return receipt("layer2", { schema_version: 1 as const, layer: "semantic" as const,
    status: "skipped" as const, input_hash, evaluator_invoked: false, findings: [], completed_at: input.completed_at });
  let evaluated: readonly QualityFinding[] = projection.findings;
  if (input.evaluator_port !== undefined) {
    try { evaluated = findings([...projection.findings, ...snap<readonly QualityFinding[]>(input.evaluator_port.evaluate({
      profile, trusted: artifacts, approved_decisions: projection.approved_decisions,
      rejected_alternatives: projection.rejected_alternatives, builtin_findings: projection.findings, input_hash }))]); }
    catch { evaluated = findings([...projection.findings, { finding_id: "semantic.evaluator_failure", category: "semantic",
      severity: profile.mode === "assurance" ? "blocking" : "advisory",
      source_refs: ["design.md"], message_zh: "语义评估器不可用，结果仅保留为建议", suggested_location: "design.md" }]); }
  }
  const blocking = evaluated.some((item) => item.severity === "blocking");
  const status = blocking && profile.mode === "assurance" ? "blocked" as const : blocking ? "failed" as const : "passed" as const;
  return receipt("layer2", { schema_version: 1 as const, layer: "semantic" as const, status, input_hash,
    evaluator_invoked: input.evaluator_port !== undefined, findings: evaluated, completed_at: input.completed_at });
}

function semanticInputHash(artifacts: TrustedArtifactSetInput,
  projection: ReturnType<typeof semanticProjection>): string {
  return hash({ artifact_set: artifacts, profile: artifacts.human_input.profile,
    evidence: artifacts.human_input.evidence, approved_decisions: projection.approved_decisions,
    rejected_alternatives: projection.rejected_alternatives, builtin_findings: projection.findings });
}

function semanticAnchor(layer2: Layer2Receipt) {
  return freeze({ input_hash: layer2.input_hash, evaluator_invoked: layer2.evaluator_invoked,
    findings: layer2.findings, status: layer2.status, completed_at: layer2.completed_at });
}

// 对抗层 input_hash 只锚定语义层的内容身份（input_hash 本身已覆盖产物+投影）。
// completed_at / receipt_hash 是运行期信封——纳入会让墙钟时间污染 input_hash，
// 静态评审收据永远无法预置匹配（每次 finalize 哈希都不同）。
function layer3SemanticBinding(layer2: Layer2Receipt) {
  return freeze({ input_hash: layer2.input_hash, evaluator_invoked: layer2.evaluator_invoked,
    findings: layer2.findings, status: layer2.status });
}

function validateSemanticAnchor(artifacts: TrustedArtifactSetInput, value: unknown):
ReturnType<typeof semanticAnchor> {
  if (!record(value) || !exact(value, ["input_hash", "evaluator_invoked", "findings", "status", "completed_at"]) ||
    typeof value.input_hash !== "string" || !sha.test(value.input_hash) || typeof value.evaluator_invoked !== "boolean" ||
    !Array.isArray(value.findings) || !same(findings(value.findings), value.findings) ||
    !["passed", "failed", "blocked", "skipped"].includes(value.status as string) || !time(value.completed_at)) {
    return fail("PLAN_QUALITY_INPUT_INVALID");
  }
  const projection = semanticProjection(artifacts); const expectedHash = semanticInputHash(artifacts, projection);
  const profile = artifacts.human_input.profile;
  const candidateFindings = value.findings as readonly QualityFinding[];
  if (value.input_hash !== expectedHash || projection.findings.some((finding) =>
    !candidateFindings.some((candidate) => same(candidate, finding))) ||
    (profile.mode === "quick" && (value.evaluator_invoked || candidateFindings.length > 0 || value.status !== "skipped"))) {
    return fail("PLAN_QUALITY_INPUT_INVALID");
  }
  const blocking = candidateFindings.some((finding) => finding.severity === "blocking");
  const expectedStatus = profile.mode === "quick" ? "skipped" : blocking && profile.mode === "assurance" ?
    "blocked" : blocking ? "failed" : "passed";
  if (value.status !== expectedStatus) return fail("PLAN_QUALITY_INPUT_INVALID");
  return value as ReturnType<typeof semanticAnchor>;
}

function requiredLenses(capabilities: readonly string[]): readonly QualityLens[] {
  const set = new Set<QualityLens>(["dependency_seam", "failure_modes", "observability", "user_behavior"]);
  if (capabilities.includes("api")) set.add("interface_contract");
  if (capabilities.includes("database")) set.add("data_consistency");
  if (capabilities.includes("migration")) set.add("migration_rollback");
  if (capabilities.includes("concurrency")) set.add("concurrency_retry");
  if (capabilities.includes("security") || capabilities.includes("permissions")) set.add("security_audit");
  return [...set].sort(cp);
}

function derivedLenses(artifacts: TrustedArtifactSetInput, semanticFindings: readonly QualityFinding[]): readonly LensAssessment[] {
  const required = requiredLenses([...artifacts.machine_input.capabilities]);
  return allLenses.map((lens): LensAssessment => required.includes(lens) ? { lens,
    applicability: "applicable", finding_refs: semanticFindings.filter((finding) =>
      finding.category.includes(lens) || finding.category === "semantic").map((finding) => finding.finding_id) } :
    { lens, applicability: "not_applicable", finding_refs: [], not_applicable_reason: "trusted_capability_not_present" });
}

function derivedHighRiskFindings(artifacts: TrustedArtifactSetInput,
  semanticFindings: readonly QualityFinding[]): readonly QualityFinding[] {
  return findings([
    ...semanticFindings.filter((finding) => finding.severity === "blocking"),
    ...artifacts.human.test_scenarios.content.scenarios.filter((scenario) => scenario.risk_level === "high")
      // HP-03：不用有损字符替换构造身份（大写片段碰撞）；稳定哈希派生 + 原文保留在内容
      .map((scenario) => ({ finding_id: `risk:${hash(scenario.scenario_id).slice(7)}`,
        category: "high_risk_scenario", severity: "advisory" as const, source_refs: ["test-scenarios.md"],
        message_zh: `高风险场景需要独立复核：${scenario.title}`, suggested_location: "test-scenarios.md" }))
  ]);
}

function lensInput(value: readonly LensAssessment[], required: readonly QualityLens[]): readonly LensAssessment[] {
  if (!Array.isArray(value) || value.length !== allLenses.length || !value.every((item) => record(item) &&
    exact(item, ["lens", "applicability", "finding_refs"], ["not_applicable_reason"]) &&
    typeof item.lens === "string" && allLenses.includes(item.lens as QualityLens) &&
    (item.applicability === "applicable" || item.applicability === "not_applicable") && strings(item.finding_refs, 0, 64) &&
    (item.applicability === "applicable" ? item.not_applicable_reason === undefined : text(item.not_applicable_reason)))) {
    return fail("PLAN_QUALITY_INPUT_INVALID");
  }
  const sorted = [...value].sort((a, b) => cp(a.lens, b.lens));
  if (!same(sorted.map((item) => item.lens), allLenses) || sorted.some((item) =>
    required.includes(item.lens) && item.applicability !== "applicable")) return fail("PLAN_QUALITY_INPUT_INVALID");
  return sorted;
}

function adversarial(input: Parameters<PlanQualityModule["runAdversarialGates"]>[0]): Layer3Receipt {
  if (!record(input) || !exact(input, ["trusted", "semantic", "explicit_adversarial",
    "prefer_delegated", "completed_at"], ["reviewer_port"]) || !time(input.completed_at) ||
    typeof input.explicit_adversarial !== "boolean" ||
    typeof input.prefer_delegated !== "boolean") return fail("PLAN_QUALITY_INPUT_INVALID");
  const artifacts = trusted(input.trusted); const semanticReceipt = input.semantic;
  const semanticExpected = semanticProjection(artifacts);
  const expectedSemanticHash = semanticInputHash(artifacts, semanticExpected);
  if (!record(semanticReceipt) || !receiptClosed(semanticReceipt, "layer2") ||
    semanticReceipt.input_hash !== expectedSemanticHash || !Array.isArray(semanticReceipt.findings) ||
    !same(findings(semanticReceipt.findings), semanticReceipt.findings)) return fail("PLAN_QUALITY_INPUT_INVALID");
  const capabilities = [...artifacts.machine_input.capabilities].sort(cp);
  const lenses = derivedLenses(artifacts, semanticReceipt.findings);
  const highRisk = derivedHighRiskFindings(artifacts, semanticReceipt.findings);
  const triggered = artifacts.human_input.profile.mode === "assurance" || input.explicit_adversarial || highRisk.length > 0 ||
    semanticReceipt.findings.some((item) => item.severity === "blocking");
  const high_risk_findings_hash = hash(highRisk);
  const input_hash = hash({ artifacts, semantic: layer3SemanticBinding(semanticReceipt), capabilities,
    high_risk_findings_hash, lenses });
  if (!triggered) {
    const review_execution: ReviewExecutionReceipt = { schema_version: 1, review_mode: "inline",
      delegation_attempted: false, delegation_outcome: "not_requested", reviewer_identity: "not_required",
      input_hash, findings_hash: hash([]), completed_at: input.completed_at };
    return receipt("layer3", { schema_version: 1 as const, layer: "adversarial" as const, status: "skipped" as const,
      input_hash, high_risk_findings_hash, lenses, findings: [], review_execution, completed_at: input.completed_at });
  }
  let mode: "inline" | "delegated" = input.prefer_delegated ? "delegated" : "inline";
  let outcome: ReviewExecutionReceipt["delegation_outcome"] = input.prefer_delegated ? "succeeded" : "not_requested";
  let fallback: ReviewExecutionReceipt["fallback_reason"] | undefined;
  let result: ReturnType<AdversarialReviewerPort["review"]>;
  if (input.prefer_delegated && input.reviewer_port === undefined) {
    mode = "inline"; outcome = "unavailable"; fallback = "delegation_unavailable";
  }
  if (input.reviewer_port !== undefined) {
    try { result = snap<NonNullable<typeof result>>(input.reviewer_port.review({ mode, input_hash, trusted: artifacts,
      semantic_findings: semanticReceipt.findings, high_risk_findings: highRisk, lenses })); }
    catch { if (mode === "delegated") { outcome = "failed"; fallback = "delegation_failed"; } }
    if (mode === "delegated" && result === undefined) {
      if (fallback === undefined) { outcome = "unavailable"; fallback = "delegation_empty"; }
      mode = "inline";
      try { result = snap<NonNullable<typeof result>>(input.reviewer_port.review({ mode, input_hash, trusted: artifacts,
        semantic_findings: semanticReceipt.findings, high_risk_findings: highRisk, lenses })); }
      catch { result = undefined; }
    }
  }
  let reviewedResult = reviewerResult(result);
  if (reviewedResult?.reviewer_identity === "review_unavailable") {
    outcome = "unavailable";
    if (mode === "delegated") {
      fallback = "delegation_unavailable";
      mode = "inline";
      try { result = snap<NonNullable<typeof result>>(input.reviewer_port?.review({ mode, input_hash, trusted: artifacts,
        semantic_findings: semanticReceipt.findings, high_risk_findings: highRisk, lenses })); }
      catch { result = undefined; }
      reviewedResult = reviewerResult(result);
    }
  }
  if (outcome === "unavailable" && fallback !== undefined && reviewedResult !== undefined &&
      reviewedResult.reviewer_identity !== "review_unavailable") outcome = "failed";
  const reviewed = reviewedResult === undefined ? highRisk : findings([...highRisk, ...reviewedResult.findings]);
  const missingReview = reviewedResult === undefined;
  const blocking = reviewed.some((item) => item.severity === "blocking") || missingReview ||
    reviewedResult?.reviewer_identity === "review_unavailable";
  if (missingReview) outcome = "unavailable";
  const review_execution: ReviewExecutionReceipt = freeze({ schema_version: 1, review_mode: mode,
    delegation_attempted: input.prefer_delegated, delegation_outcome: outcome, ...(fallback === undefined ? {} :
      { fallback_reason: fallback }), reviewer_identity: reviewedResult?.reviewer_identity ?? "review_unavailable",
    input_hash, findings_hash: hash(reviewed), completed_at: input.completed_at });
  return receipt("layer3", { schema_version: 1 as const, layer: "adversarial" as const,
    status: blocking ? "blocked" as const : "passed" as const, input_hash, high_risk_findings_hash, lenses,
    findings: reviewed,
    review_execution, completed_at: input.completed_at });
}

function event(input: Omit<PlanEvent, "schema_version" | "event_id" | "idempotency_key">): PlanEvent {
  const machine = { lifecycle_kind: input.lifecycle_kind, run_id: input.run_id, change_key: input.change_key, phase: input.phase, attempt: input.attempt,
    type: input.type, producer_seq: input.producer_seq };
  const event_id = `plan_event:${hash({ ...machine, occurred_at: input.occurred_at }).slice(7)}`;
  return freeze({ schema_version: 1, ...input, event_id, idempotency_key: hash(machine) });
}

function finalize(input: Parameters<PlanQualityModule["finalizeQuality"]>[0]): ReturnType<PlanQualityModule["finalizeQuality"]> {
  if (!record(input) || !exact(input, ["trusted", "layer1", "layer2", "layer3", "trusted_stage_verification",
    "trusted_semantic_projection", "trusted_review_execution", "publication", "run_id", "attempt",
    "phase", "completed_at"]) || !text(input.run_id, 160) || !identity.test(input.run_id) || !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1 || !PLAN_PHASES.includes(input.phase) || !time(input.completed_at)) return fail("PLAN_QUALITY_INPUT_INVALID");
  const artifacts = trusted(input.trusted); if (!validPublication(input.publication)) return fail("PLAN_QUALITY_INPUT_INVALID");
  if (input.publication.approval_receipt_ref !== artifacts.human_input.approval_receipt.receipt_id ||
    !same(input.publication.artifact_derivation_receipt_refs, [artifacts.human.artifact_set_hash,
      artifacts.machine.artifact_set_hash, artifacts.detail.content_hash])) return fail("PLAN_QUALITY_INPUT_INVALID");
  const profile = artifacts.human_input.profile;
  const expectedStage = stageVerificationInput(input.publication, artifacts);
  const trustedStage = validateStageEvidence(input.trusted_stage_verification, expectedStage);
  if (!record(input.layer1) || !time(input.layer1.completed_at)) return fail("PLAN_QUALITY_INPUT_INVALID");
  const expectedLayer1 = deterministicWithEvidence(artifacts, input.publication,
    trustedStage, input.layer1.completed_at);
  const semanticExpected = semanticProjection(artifacts);
  const expectedSemanticAnchor = validateSemanticAnchor(artifacts, input.trusted_semantic_projection);
  const expectedSemanticInputHash = semanticInputHash(artifacts, semanticExpected);
  if (!same(input.layer1.stage_verification, trustedStage) || !same(expectedLayer1, input.layer1) ||
    !record(input.layer2) || !exact(input.layer2, ["schema_version", "layer",
    "status", "input_hash", "evaluator_invoked", "findings", "completed_at", "receipt_hash", "receipt_id"]) ||
    !receiptClosed(input.layer2, "layer2") ||
    input.layer2.schema_version !== 1 || input.layer2.layer !== "semantic" ||
    typeof input.layer2.evaluator_invoked !== "boolean" || input.layer2.input_hash !== expectedSemanticInputHash ||
    !Array.isArray(input.layer2.findings) || !same(findings(input.layer2.findings), input.layer2.findings) ||
    !same(semanticAnchor(input.layer2), expectedSemanticAnchor) ||
    !time(input.layer2.completed_at) || !record(input.layer3) || !exact(input.layer3, ["schema_version", "layer",
      "status", "input_hash", "high_risk_findings_hash", "lenses", "findings", "review_execution", "completed_at",
      "receipt_hash", "receipt_id"]) ||
    !receiptClosed(input.layer3, "layer3") ||
    input.layer3.schema_version !== 1 || input.layer3.layer !== "adversarial" || !Array.isArray(input.layer3.findings) ||
    !same(findings(input.layer3.findings), input.layer3.findings) || !time(input.layer3.completed_at)) {
    return fail("PLAN_QUALITY_INPUT_INVALID");
  }
  const semanticBlocking = input.layer2.findings.some((item) => item.severity === "blocking");
  const expectedSemanticStatus = profile.mode === "quick" ? "skipped" : semanticBlocking && profile.mode === "assurance" ?
    "blocked" : semanticBlocking ? "failed" : "passed";
  if (input.layer2.status !== expectedSemanticStatus || (profile.mode === "quick" &&
    (input.layer2.evaluator_invoked || input.layer2.findings.length > 0))) return fail("PLAN_QUALITY_INPUT_INVALID");
  const capabilities = [...artifacts.machine_input.capabilities].sort(cp);
  const expectedLenses = derivedLenses(artifacts, input.layer2.findings);
  const expectedHighRisk = derivedHighRiskFindings(artifacts, input.layer2.findings);
  const expectedHighRiskHash = hash(expectedHighRisk);
  const expectedLayer3Hash = hash({ artifacts, semantic: layer3SemanticBinding(input.layer2), capabilities,
    high_risk_findings_hash: expectedHighRiskHash, lenses: expectedLenses });
  const required = requiredLenses(capabilities);
  const actualLenses = lensInput(input.layer3.lenses, required);
  if (!same(actualLenses, expectedLenses) ||
    input.layer3.input_hash !== expectedLayer3Hash || typeof input.layer3.high_risk_findings_hash !== "string" ||
    input.layer3.high_risk_findings_hash !== expectedHighRiskHash ||
    expectedHighRisk.some((finding) => !input.layer3.findings.some((candidate) => same(candidate, finding))) ||
    !record(input.layer3.review_execution) ||
    !exact(input.layer3.review_execution, ["schema_version", "review_mode", "delegation_attempted",
      "delegation_outcome", "reviewer_identity", "input_hash", "findings_hash", "completed_at"], ["fallback_reason"]) ||
    input.layer3.review_execution.input_hash !== input.layer3.input_hash ||
    input.layer3.review_execution.findings_hash !== hash(input.layer3.findings) ||
    input.layer3.review_execution.completed_at !== input.layer3.completed_at ||
    !same(input.trusted_review_execution, input.layer3.review_execution)) return fail("PLAN_QUALITY_INPUT_INVALID");
  const execution = input.layer3.review_execution;
  const fallbackValid = execution.fallback_reason === undefined ||
    ["delegation_unavailable", "delegation_failed", "delegation_empty"].includes(execution.fallback_reason);
  const reviewerAvailabilityConsistent = (execution.reviewer_identity === "review_unavailable") ===
    (execution.delegation_outcome === "unavailable");
  const delegationStateValid = !execution.delegation_attempted ?
    execution.review_mode === "inline" && ["not_requested", "unavailable"].includes(execution.delegation_outcome) &&
      execution.fallback_reason === undefined : execution.review_mode === "delegated" ?
    execution.delegation_outcome === "succeeded" && execution.fallback_reason === undefined :
    execution.review_mode === "inline" && ["failed", "unavailable"].includes(execution.delegation_outcome) &&
      execution.fallback_reason !== undefined;
  if (execution.schema_version !== 1 || !["inline", "delegated"].includes(execution.review_mode) ||
    typeof execution.delegation_attempted !== "boolean" ||
    !["not_requested", "succeeded", "unavailable", "failed"].includes(execution.delegation_outcome) ||
    !text(execution.reviewer_identity, 160) || !identity.test(execution.reviewer_identity) ||
    typeof execution.findings_hash !== "string" || !sha.test(execution.findings_hash) || !time(execution.completed_at) ||
    !fallbackValid || !delegationStateValid || !reviewerAvailabilityConsistent) {
    return fail("PLAN_QUALITY_INPUT_INVALID");
  }
  const adversarialBlocking = input.layer3.findings.some((finding) => finding.severity === "blocking") ||
    execution.reviewer_identity === "review_unavailable";
  const expectedAdversarialStatus = execution.reviewer_identity === "not_required" ? "skipped" :
    adversarialBlocking ? "blocked" : "passed";
  if (input.layer3.status !== expectedAdversarialStatus || (input.layer3.status === "skipped" &&
    (input.layer3.findings.length > 0 || execution.delegation_attempted))) return fail("PLAN_QUALITY_INPUT_INVALID");
  const layersAccept = input.layer1.status === "passed" && !["failed", "blocked"].includes(input.layer2.status) &&
    !["failed", "blocked"].includes(input.layer3.status) && (profile.mode !== "assurance" ||
      input.layer2.status === "passed" && input.layer3.status === "passed");
  const publicationAccept = input.layer1.publication_intent_id === input.publication.publication_intent_id &&
    input.layer1.publication_evidence_hash === hash(input.publication) && input.layer1.artifact_set_hash === hash(artifacts);
  const succeeded = layersAccept && publicationAccept;
  const body = { schema_version: 1 as const, status: succeeded ? "succeeded" as const : "blocked" as const,
    run_id: input.run_id, change_key: artifacts.human.plan.content.change_key, profile_ref: profile.profile_id,
    artifact_set_hash: hash(artifacts), layer_receipt_hashes: [input.layer1.receipt_hash, input.layer2.receipt_hash,
      input.layer3.receipt_hash], publication_intent_id: input.publication.publication_intent_id,
    finalizer_action: succeeded ? "publish" as const : "none" as const, completed_at: input.completed_at };
  const finalReceipt = receipt("finalization", body) as PlanFinalizationReceipt;
  const common = { lifecycle_kind: "change" as const, run_id: input.run_id, change_key: body.change_key, phase: input.phase, attempt: input.attempt,
    occurred_at: input.completed_at };
  const middle = succeeded ? event({ ...common, type: "artifact_published", producer_seq: 2,
    summary_zh: "规划产物已通过发布门", receipt_ref: finalReceipt.receipt_id }) :
    event({ ...common, type: "validation_failed", producer_seq: 2, summary_zh: "规划质量门未通过",
      receipt_ref: finalReceipt.receipt_id });
  return freeze({ receipt: finalReceipt, events: [event({ ...common, type: "phase_started", producer_seq: 1 }), middle,
    event({ ...common, type: "phase_ended", producer_seq: 3, receipt_ref: finalReceipt.receipt_id })] });
}

export function createPlanQualityModule(): PlanQualityModule {
  return freeze({
    readEventBundle(input) {
      return readPlanEventBundle(input, {
        sha256(canonicalPayload) { return hash(JSON.parse(canonicalPayload) as unknown); }
      });
    },
    runDeterministicGates(input) { return deterministic(withPort(input, ["trusted", "publication", "completed_at"],
      "stage_verifier_port", "verify")); },
    runSemanticGates(input) { return semantic(withPort(input, ["trusted", "completed_at"], "evaluator_port", "evaluate")); },
    runAdversarialGates(input) { return adversarial(withPort(input, ["trusted", "semantic",
      "explicit_adversarial", "prefer_delegated", "completed_at"],
      "reviewer_port", "review")); },
    finalizeQuality(input) { return finalize(snap(input)); },
    verifyFinalization(input) {
      try { const value = snapshot(input) as typeof input;
        if (!record(value) || !exact(value, ["trusted", "layer1", "layer2", "layer3",
          "trusted_stage_verification", "trusted_semantic_projection", "trusted_review_execution", "publication",
          "execution_identity", "receipt", "events"]) || !record(value.execution_identity) ||
          !exact(value.execution_identity, ["run_id", "change_key", "phase", "attempt", "completed_at",
            "publication_intent_id"]))
          return freeze({ valid: false, reason_code: "PLAN_QUALITY_INVALID" });
        const expected = finalize({ trusted: value.trusted, layer1: value.layer1, layer2: value.layer2,
          layer3: value.layer3, trusted_stage_verification: value.trusted_stage_verification,
          trusted_semantic_projection: value.trusted_semantic_projection,
          trusted_review_execution: value.trusted_review_execution,
          publication: value.publication, run_id: value.execution_identity.run_id,
          attempt: value.execution_identity.attempt, phase: value.execution_identity.phase,
          completed_at: value.execution_identity.completed_at });
        if (value.execution_identity.change_key !== value.trusted.human.plan.content.change_key ||
          value.execution_identity.publication_intent_id !== value.publication.publication_intent_id) {
          return freeze({ valid: false, reason_code: "PLAN_QUALITY_INVALID" });
        }
        return freeze(same(expected.receipt, value.receipt) && same(expected.events, value.events) ?
          { valid: true, reason_code: "PLAN_QUALITY_VALID" } : { valid: false, reason_code: "PLAN_QUALITY_INVALID" });
      } catch { return freeze({ valid: false, reason_code: "PLAN_QUALITY_INVALID" }); }
    },
    normalizeLegacy(input) {
      try { const value = snapshot(input);
        if (!record(value)) return freeze({ ok: false, reason_code: "PLAN_QUALITY_RECORD_INVALID" });
        if (value.schemaVersion === 0 && exact(value, ["schemaVersion", "status", "checks"]) &&
          (value.status === "passed" || value.status === "failed") && strings(value.checks, 1, 32)) return freeze({ ok: true,
          source_schema_version: 0, readiness: "legacy_read_only", status: value.status, checks: value.checks });
        const version = value.schemaVersion ?? value.schema_version;
        return freeze({ ok: false, reason_code: version === undefined || version === 0 || version === 1 ?
          "PLAN_QUALITY_RECORD_INVALID" : "PLAN_QUALITY_VERSION_UNSUPPORTED" });
      } catch { return freeze({ ok: false, reason_code: "PLAN_QUALITY_RECORD_INVALID" }); }
    }
  });
}
