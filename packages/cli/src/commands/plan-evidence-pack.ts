import { createHash } from "node:crypto";

import { canonicalJson, isValidPlanRunId } from "@hunter-harness/contracts";

import { emitPlanError, planErrorEnvelope } from "./plan-error.js";
import { readFile, writeFile } from "node:fs/promises";

import {
  PLAN_PHASES,
  classifyPlan,
  configurePlannedPhases,
  createPlanArtifactModel,
  createPlanDecisionModule,
  createPlanningContextModule,
  type ApprovalContentInput,
  type HumanArtifactBuildInput
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { createPlanFinalizationRenderer } from "../plan-finalization/production-ports.js";

export interface PlanEvidencePackOptions {
  input: string;
  output: string;
  printTemplate?: boolean;
}

/**
 * `EvidencePackInputFile` 的可运行骨架。
 *
 * 这个模板是为了让 v2 路径可被发现：此前 schema 的唯一权威定义就是本文件的
 * TypeScript 接口，agent 在 npx 缓存、全局 node_modules、归档里翻遍也找不到样例，
 * 最后只能退回 legacy 路径。`--print-template` 让 CLI 自己交出结构。
 *
 * **不变量：模板一个字不改必须能通过本命令**（`plan-evidence-pack-template.test.ts`
 * 冻结）。骨架若与校验器漂移，调用方拿到的就是"必定失败的样例"——只能去反编译
 * dist bundle 找契约，这正是本模板存在要消除的成本。因此：
 * - 受枚举/哈希/路径约束的字段一律给**真实合法值**，不用 `<...>`
 * - 自由文本字段才用 `<...>`，便于逐项替换后 grep `<` 自检
 * - 必须换成真值但无法带 `<` 的字段（run_id/content_hash）用自解释占位量
 */
const EVIDENCE_PACK_TEMPLATE = {
  // 必须换成真实 change-name；受 kebab-case 约束（^[a-z0-9]+(-[a-z0-9]+)*$），带不了 <>
  change_key: "replace-with-change-name",
  // 枚举见 PLAN_RISK_SIGNALS：api_change/artifact_protocol/auth/breaking_contract/
  // concurrency/cross_file/delete/docs_only/irreversible_operation/migration/
  // narrow_fix/payment/permission/production_code/security/shared_state/user_visible_behavior
  risk_signals: ["production_code"],
  mode: "standard",
  intent: {
    source_input: "<用户原话需求>",
    goal: "<一句话目标>",
    user_visible_outcome: "<用户能观察到的结果>",
    // in_scope / out_of_scope 必须与 approval.content 的同名字段集合相等（顺序无关）
    in_scope: ["<纳入范围条目>"],
    out_of_scope: ["<明确排除条目>"],
    constraints: [],
    // intent 要 2~5 条、approval 要 3~7 条，取 3 条同时满足
    acceptance_examples: ["<验收例子 1>", "<验收例子 2>", "<验收例子 3>"],
    uncertainties: []
  },
  approval: {
    // 必须来自阶段 4 blocking confirmation 的真实结果，本命令不伪造审批。
    // decided_at 可选：省略取当前时间；有真实审批时刻时补 ISO 8601 字符串。
    content: {
      goal: "<一句话目标>",
      user_visible_outcome: "<用户能观察到的结果>",
      in_scope: ["<纳入范围条目>"],
      out_of_scope: ["<明确排除条目>"],
      recommended_design: "<采纳的设计方案>",
      key_alternatives: ["<被否决的方案及原因>"],
      invariants: ["<必须始终成立的性质>"],
      failure_behaviors: ["<失败时的预期行为>"],
      compatibility_boundaries: ["<兼容性边界>"],
      risks: [{ risk: "<风险>", mitigation: "<缓解措施>" }],
      acceptance_examples: ["<验收例子 1>", "<验收例子 2>", "<验收例子 3>"]
    },
    approver_id: "<真实审批人标识>"
  },
  evidence_sources: [
    {
      source_kind: "file",
      source_id: "<证据来源标识，如文件路径或 codegraph 查询>",
      source_version: "<版本标识，如 git 短哈希>",
      // 必须换成证据源内容的真实 sha256（校验器显式拒绝全 0，防的就是占位当证据）
      content_hash: `sha256:${"deadbeef".repeat(8)}`,
      module_refs: [],
      symbol_refs: [],
      consumer_refs: [],
      test_refs: [],
      constraint_refs: [],
      unknown_refs: []
    }
  ],
  structured_input: {
    // 六个 refs 数组由命令接线，写了会被覆盖；这里只给自然字段
    tasks: [
      {
        task_id: "<T1>",
        objective: "<这个任务要达成什么>",
        affected_paths: ["<相对路径，如 src/module/file.ts>"],
        owner_phase: "run"
      }
    ],
    // 至少 3 条（冻结校验器下限）。八维度缺项由命令补 not_applicable，
    // 不必为凑维度编场景；coverage_dimension 枚举见 COVERAGE_DIMENSIONS。
    scenarios: [
      {
        scenario_id: "<UT-001>",
        title: "<正常路径场景描述>",
        acceptance: "<可判定的通过标准>",
        coverage_dimension: "normal_path",
        execution_level: "unit",
        evidence_requirements: ["<证据要求，如 focused_test>"],
        risk_level: "medium",
        verification_command: "<验证命令，可整条删除>"
      },
      {
        scenario_id: "<UT-002>",
        title: "<参数校验场景描述>",
        acceptance: "<可判定的通过标准>",
        coverage_dimension: "parameter_validation",
        execution_level: "unit",
        evidence_requirements: ["<证据要求，如 focused_test>"],
        risk_level: "low"
      },
      {
        scenario_id: "<UT-003>",
        title: "<错误码场景描述>",
        acceptance: "<可判定的通过标准>",
        coverage_dimension: "error_codes",
        execution_level: "unit",
        evidence_requirements: ["<证据要求，如 focused_test>"],
        risk_level: "medium"
      }
    ],
    approved_scopes: [{ text: "<纳入范围条目>" }]
  },
  machine: {
    // 枚举：api/concurrency/database/filesystem/migration/network/permissions/security/ui
    capabilities: [],
    worktree_policy: "project_default"
  },
  context: {
    project_id: "<project.yaml 的 project_id>",
    // 必须换成阶段 0.5 生成、phase.start 已用的同一个 plan-run-id
    run_id: "plan_replace-with-your-plan-run-id",
    branch_name: "<当前分支>",
    attempt: 1
  },
  expected_baseline: { state: "absent", manifest_hash: null, generation: 0 }
} as const;

/**
 * `hunter-harness plan evidence-pack --input <structured.json> --output <evidence.json>`
 *
 * 阶段 14 桥：把规划自然产出（intent / 审批内容 / tasks / scenarios / evidence sources）
 * 经冻结模块链（classify → planning-context → decision → artifact-model → renderer）
 * 组装为 `plan finalize` 可直接消费的证据包。
 *
 * 语义边界：审批必须是真实用户确认后的记录——approver_id/decided_at 由
 * 阶段 4 blocking confirmation 的实际结果传入，本命令不伪造审批。
 */
interface EvidencePackInputFile {
  change_key: string;
  risk_signals: readonly string[];
  mode?: "quick" | "standard" | "assurance";
  intent: {
    source_input: string;
    goal: string;
    user_visible_outcome: string;
    in_scope: readonly string[];
    out_of_scope: readonly string[];
    constraints?: readonly string[];
    acceptance_examples: readonly string[];
    uncertainties?: readonly string[];
  };
  approval: {
    content: ApprovalContentInput;
    approver_id: string;
    decided_at?: string;
  };
  decision_nodes?: readonly unknown[];
  evidence_sources: readonly Record<string, unknown>[];
  structured_input: {
    tasks: readonly Record<string, unknown>[];
    scenarios: readonly Record<string, unknown>[];
    coverage?: readonly Record<string, unknown>[];
    requirements?: readonly Record<string, unknown>[];
    approved_scopes: readonly { scope_ref?: string; text: string }[];
    ownership?: readonly Record<string, unknown>[];
  };
  machine: {
    capabilities: readonly string[];
    worktree_policy: string;
  };
  context: {
    project_id: string;
    run_id: string;
    branch_name: string;
    attempt: number;
  };
  expected_baseline: { state: "absent"; manifest_hash: null; generation: 0 } |
    { state: "present"; manifest_hash: string; generation: number };
}

const COVERAGE_DIMENSIONS = ["business_rules", "concurrency_idempotency", "data_compatibility", "error_codes",
  "integration_impact", "normal_path", "parameter_validation", "permission_boundaries"] as const;

// 自然输入的键集与枚举（与冻结校验器同源；命令派生的字段列在 *_DERIVED/_OPTIONAL）
const EVIDENCE_SOURCE_KEYS = ["source_kind", "source_id", "source_version", "content_hash",
  "module_refs", "symbol_refs", "consumer_refs", "test_refs", "constraint_refs", "unknown_refs"] as const;
const SOURCE_KINDS = ["map", "codegraph", "file", "config"] as const;
const TASK_KEYS = ["task_id", "objective", "affected_paths", "owner_phase"] as const;
const TASK_DERIVED_KEYS = ["depends_on", "decision_refs", "scenario_refs", "requirement_refs",
  "evidence_refs", "ownership_refs"] as const;
const SCENARIO_KEYS = ["scenario_id", "title", "acceptance", "coverage_dimension", "execution_level",
  "evidence_requirements", "risk_level"] as const;
const SCENARIO_OPTIONAL_KEYS = ["verification_command", "task_refs", "requirement_refs"] as const;
const EXECUTION_LEVELS = ["unit", "api", "data_compatibility", "integration", "system"] as const;
const RISK_LEVELS = ["low", "medium", "high"] as const;
const WORKTREE_POLICIES = ["project_default", "required", "forbidden"] as const;

interface InputProblem {
  readonly field_path: string;
  readonly missing_keys?: readonly string[];
  readonly unexpected_keys?: readonly string[];
  readonly message?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 键集差异 → 一条带 missing/unexpected 的问题；键集相符返回 undefined。 */
function keySetProblem(value: Record<string, unknown>, fieldPath: string,
  required: readonly string[], allowed: readonly string[]): InputProblem | undefined {
  const present = Object.keys(value);
  const missing = required.filter((key) => !present.includes(key));
  const unexpected = present.filter((key) => !allowed.includes(key));
  if (missing.length === 0 && unexpected.length === 0) return undefined;
  return {
    field_path: fieldPath,
    ...(missing.length > 0 ? { missing_keys: missing } : {}),
    ...(unexpected.length > 0 ? { unexpected_keys: unexpected } : {}),
    message: `键集不符合契约；必需 ${required.join("/")}` +
      (allowed.length > required.length
        ? `，可选 ${allowed.filter((key) => !required.includes(key)).join("/")}`
        : "")
  };
}

/** 已存在的字段才查枚举——缺键由 keySetProblem 报告，避免同一处重复报错。 */
function enumProblem(value: Record<string, unknown>, key: string, fieldPath: string,
  allowed: readonly string[]): InputProblem | undefined {
  if (!(key in value)) return undefined;
  if (typeof value[key] === "string" && allowed.includes(value[key] as string)) return undefined;
  return { field_path: `${fieldPath}.${key}`, message: `取值必须是 ${allowed.join(" | ")}` };
}

/**
 * HP-13：自然输入的结构问题在边界一次报清，带 field_path 与缺失/多余键。
 *
 * 冻结模块只抛 `PLANNING_EVIDENCE_INVALID` / `PLAN_ARTIFACT_INPUT_INVALID` 这类
 * 无定位信息的稳定码，调用方唯一的出路是反编译 bundle 逐个校验器比对。本层把
 * 键集与枚举这两类高频错误挡在前面，让第一次失败就说清改哪里。
 */
function collectInputProblems(input: EvidencePackInputFile): readonly InputProblem[] {
  const problems: InputProblem[] = [];
  const sources: unknown = input.evidence_sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    problems.push({ field_path: "evidence_sources", message: "必须是非空数组" });
  } else {
    sources.forEach((source, index) => {
      const path = `evidence_sources[${index}]`;
      if (!isRecord(source)) {
        problems.push({ field_path: path, message: "必须是对象" });
        return;
      }
      const keyProblem = keySetProblem(source, path, EVIDENCE_SOURCE_KEYS, EVIDENCE_SOURCE_KEYS);
      if (keyProblem !== undefined) problems.push(keyProblem);
      const kindProblem = enumProblem(source, "source_kind", path, SOURCE_KINDS);
      if (kindProblem !== undefined) problems.push(kindProblem);
      // 与 core shaPattern 同源：全 0 被显式拒绝，防的是"占位当证据"
      if ("content_hash" in source &&
        !/^sha256:(?!0{64}$)[a-f0-9]{64}$/u.test(String(source.content_hash))) {
        problems.push({
          field_path: `${path}.content_hash`,
          message: "必须是证据源内容的真实 sha256:<64 位小写十六进制>（全 0 占位会被拒绝）"
        });
      }
    });
  }

  const structured: unknown = input.structured_input;
  if (!isRecord(structured)) {
    problems.push({ field_path: "structured_input", message: "必须是对象" });
    return problems;
  }

  const tasks: unknown = structured.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    problems.push({ field_path: "structured_input.tasks", message: "必须是非空数组" });
  } else {
    tasks.forEach((task, index) => {
      const path = `structured_input.tasks[${index}]`;
      if (!isRecord(task)) {
        problems.push({ field_path: path, message: "必须是对象" });
        return;
      }
      const keyProblem = keySetProblem(task, path, TASK_KEYS, [...TASK_KEYS, ...TASK_DERIVED_KEYS]);
      if (keyProblem !== undefined) problems.push(keyProblem);
      const phaseProblem = enumProblem(task, "owner_phase", path, PLAN_PHASES);
      if (phaseProblem !== undefined) problems.push(phaseProblem);
      if ("affected_paths" in task && (!Array.isArray(task.affected_paths) ||
        task.affected_paths.length === 0)) {
        problems.push({ field_path: `${path}.affected_paths`, message: "必须是至少一条相对路径的数组" });
      }
    });
  }

  const scenarios: unknown = structured.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length < 3) {
    problems.push({
      field_path: "structured_input.scenarios",
      message: "必须是至少 3 条场景的数组（冻结校验器下限；八维度缺项由命令补 not_applicable）"
    });
  }
  if (Array.isArray(scenarios)) {
    scenarios.forEach((scenario, index) => {
      const path = `structured_input.scenarios[${index}]`;
      if (!isRecord(scenario)) {
        problems.push({ field_path: path, message: "必须是对象" });
        return;
      }
      const keyProblem = keySetProblem(scenario, path, SCENARIO_KEYS,
        [...SCENARIO_KEYS, ...SCENARIO_OPTIONAL_KEYS]);
      if (keyProblem !== undefined) problems.push(keyProblem);
      for (const [key, allowed] of [["coverage_dimension", COVERAGE_DIMENSIONS],
        ["execution_level", EXECUTION_LEVELS], ["risk_level", RISK_LEVELS]] as const) {
        const problem = enumProblem(scenario, key, path, allowed);
        if (problem !== undefined) problems.push(problem);
      }
    });
  }

  const machine: unknown = input.machine;
  if (!isRecord(machine)) {
    problems.push({ field_path: "machine", message: "必须是对象" });
  } else {
    const policyProblem = enumProblem(machine, "worktree_policy", "machine", WORKTREE_POLICIES);
    if (policyProblem !== undefined) problems.push(policyProblem);
  }
  return problems;
}

const stableId = (prefix: string, body: unknown): string =>
  `${prefix}:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;


function coverageFrom(scenarios: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  // 与 core fixture 同一推导：八维全覆盖，无场景维度记 not_applicable
  return COVERAGE_DIMENSIONS.map((dimension) => {
    const refs = scenarios
      .filter((scenario) => String(scenario.coverage_dimension) === dimension)
      .map((scenario) => String(scenario.scenario_id));
    return refs.length > 0
      ? { coverage_dimension: dimension, applicability: "applicable", scenario_refs: refs }
      : { coverage_dimension: dimension, applicability: "not_applicable", scenario_refs: [],
          not_applicable_reason: `当前变更不涉及 ${dimension}` };
  });
}

function requirementsFrom(content: ApprovalContentInput, scopeRefs: readonly string[],
  evidenceRefs: readonly string[]): readonly Record<string, unknown>[] {
  // 与 core 测试 fixture 同一推导：行为 + 不变量 + 失败行为各成一条 requirement
  const source = [
    { kind: "behavior", text: content.recommended_design },
    ...content.invariants.map((text) => ({ kind: "invariant", text })),
    ...content.failure_behaviors.map((text) => ({ kind: "failure_behavior", text }))
  ];
  return source.map((item) => {
    const body = { ...item, evidence_refs: [...evidenceRefs], approved_scope_refs: [...scopeRefs] };
    return { requirement_id: stableId("requirement", body), ...body };
  });
}

export async function runPlanEvidencePack(
  options: PlanEvidencePackOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const now = () => new Date().toISOString();
  if (options.printTemplate === true) {
    // 结构可发现性优先于输出洁癖：直接把骨架打到 stdout，可重定向成输入文件
    dependencies.stdout(`${JSON.stringify(EVIDENCE_PACK_TEMPLATE, null, 2)}\n`);
    return 0;
  }
  try {
    const input = JSON.parse(await readFile(options.input, "utf8")) as EvidencePackInputFile;
    // HP-07：run_id 必须在写入任何 legacy 事件前满足 v2 identity（小写字母开头）；
    // 裸 UUID 有 10/16 概率数字开头——边界拒绝并给出字段路径，不等到 finalization
    if (!isValidPlanRunId(input.context?.run_id)) {
      return emitPlanError(dependencies.stdout, planErrorEnvelope({
        code: "PLAN_RUN_ID_INVALID",
        field_path: "context.run_id",
        message: "run_id 必须满足 v2 identity（小写字母开头）；请使用 createPlanRunId() 生成 plan_<uuid>"
      }));
    }
    // HP-13：结构问题优先于时间/范围检查——键集错了，后面的语义校验都没有意义
    const problems = collectInputProblems(input);
    const firstProblem = problems[0];
    if (firstProblem !== undefined) {
      return emitPlanError(dependencies.stdout, planErrorEnvelope({
        code: "PLAN_EVIDENCE_INPUT_INVALID",
        stage: "boundary",
        field_path: firstProblem.field_path,
        message: "自然输入结构不符合契约；逐条修正 problems 后重跑",
        extra: { problems }
      }));
    }
    // HP-11：decided_at 边界规范化为 canonical UTC（Z 与 +08:00 等价）
    const rawDecidedAt = input.approval.decided_at;
    if (rawDecidedAt !== undefined) {
      const parsedTime = Date.parse(String(rawDecidedAt));
      if (!Number.isFinite(parsedTime)) {
        return emitPlanError(dependencies.stdout, planErrorEnvelope({
          code: "PLAN_TIME_INVALID",
          field_path: "approval.decided_at",
          message: "decided_at 不是可解析的 ISO 8601 时间"
        }));
      }
      input.approval.decided_at = new Date(parsedTime).toISOString();
    }
    const createdAt = input.approval.decided_at ?? now();
    // HP-04：intent 与 approval scope 集合语义等价校验（missing/extra 明细）
    const canonicalScope = (values: readonly string[]) => [...new Set(values)].sort();
    const intentIn = canonicalScope(input.intent.in_scope ?? []);
    const approvalIn = canonicalScope(input.approval.content?.in_scope ?? []);
    const intentOut = canonicalScope(input.intent.out_of_scope ?? []);
    const approvalOut = canonicalScope(input.approval.content?.out_of_scope ?? []);
    const scopeDiff = (a: readonly string[], b: readonly string[]) => ({
      missing: b.filter((item) => !a.includes(item)),
      extra: a.filter((item) => !b.includes(item))
    });
    const inDiff = scopeDiff(intentIn, approvalIn);
    const outDiff = scopeDiff(intentOut, approvalOut);
    if (inDiff.missing.length > 0 || inDiff.extra.length > 0 ||
        outDiff.missing.length > 0 || outDiff.extra.length > 0) {
      return emitPlanError(dependencies.stdout, planErrorEnvelope({
        code: "PLAN_SCOPE_MISMATCH",
        field_path: "approval.content.in_scope",
        message: "Intent 与审批 scope 集合不等价（顺序无关）",
        extra: { diff: { in_scope: inDiff, out_of_scope: outDiff } }
      }));
    }
    const planning = createPlanningContextModule();
    const decision = createPlanDecisionModule();
    const model = createPlanArtifactModel();

    const profile = classifyPlan({ schema_version: 1, change_id: input.change_key,
      risk_signals: input.risk_signals as never, created_at: createdAt });
    const phase_set = configurePlannedPhases(profile, { schema_version: 1, is_git: true, has_remote: true,
      uses_worktree: false, available_phases: PLAN_PHASES, requested_optional_phases: [],
      requested_omissions: [], configured_at: createdAt });
    const intent = planning.buildIntent({ schema_version: 1,
      source_input: input.intent.source_input, goal: input.intent.goal,
      user_visible_outcome: input.intent.user_visible_outcome,
      in_scope: input.intent.in_scope, out_of_scope: input.intent.out_of_scope,
      constraints: input.intent.constraints ?? [],
      acceptance_examples: input.intent.acceptance_examples,
      uncertainties: input.intent.uncertainties ?? [], created_at: createdAt });
    const evidence = planning.buildEvidenceMap({ schema_version: 1,
      map_manifest_hash: (`sha256:${createHash("sha256").update(JSON.stringify(input.evidence_sources)).digest("hex")}`) as `sha256:${string}`,
      sources: input.evidence_sources as never, budget: { max_sources: 16, max_refs: 128 }, created_at: createdAt });
    const context = planning.buildPlanningContext({ profile, phase_set, intent, evidence,
      map_manifest_hash: evidence.map_manifest_hash as `sha256:${string}`, created_at: createdAt });
    const graph = decision.evaluateDecisionGraph({ schema_version: 1, profile, phase_set, context,
      intent, evidence, nodes: (input.decision_nodes ?? []) as never, evaluated_at: createdAt });
    const approval_package_input = { content: input.approval.content, created_at: createdAt };
    const approval_package = decision.buildApprovalPackage({ schema_version: 1, profile, phase_set,
      context, intent, evidence, graph, ...approval_package_input });
    const approval_receipt = decision.recordApproval({ package: approval_package, graph, profile,
      phase_set, context, intent, evidence, package_input: approval_package_input,
      outcome: "approved", approver_id: input.approval.approver_id,
      decided_at: createdAt }).receipt;

    // refs 接线由命令完成（与 core fixture 同一规则），调用方只给自然字段
    // scope_ref 是 text 的派生身份（validScope 冻结校验），不得由调用方指定（HP-12
    // 删除伪输入）；兼容期：传入的 scope_ref 若与派生不符 → 伪造拒绝，相符 → 接受
    const approvedScopes = [...input.structured_input.approved_scopes]
      .sort((left, right) => (left.text < right.text ? -1 : left.text > right.text ? 1 : 0))
      .map((scope) => ({
        scope_ref: stableId("scope", { text: scope.text }),
        text: scope.text
      }));
    const forgedScope = input.structured_input.approved_scopes.find((scope) =>
      scope.scope_ref !== undefined &&
      scope.scope_ref !== stableId("scope", { text: scope.text }));
    if (forgedScope !== undefined) {
      return emitPlanError(dependencies.stdout, planErrorEnvelope({
        code: "PLAN_SCOPE_REF_FORGED",
        field_path: "structured_input.approved_scopes",
        message: "scope_ref 是 text 的派生身份，不得指定；请只传 text"
      }));
    }
    const scopeRefs = approvedScopes.map((scope) => scope.scope_ref);
    // allowedEvidence 是 EvidenceMap 的加前缀投影（module:/symbol:/consumer:/test:/constraint:/source:）
    const evidenceRefs = [
      ...new Set(input.evidence_sources.flatMap((source) => [
        ...(source.module_refs as string[] ?? []).map((ref) => `module:${ref}`),
        ...(source.symbol_refs as string[] ?? []).map((ref) => `symbol:${ref}`),
        ...(source.consumer_refs as string[] ?? []).map((ref) => `consumer:${ref}`),
        ...(source.test_refs as string[] ?? []).map((ref) => `test:${ref}`),
        ...(source.constraint_refs as string[] ?? []).map((ref) => `constraint:${ref}`),
        `source:${String(source.source_id)}`
      ]))
    ].sort();
    // HP-05：validator 要求每条 requirement/ownership 的 ref 数组按 ref 排序去重，
    // 且 requirements 按 kind 后按 requirement_id 排序——producer 与 validator 共享
    // 同一 canonical comparator，隐式/显式路径经同一 normalize
    const sortRefs = (refs: readonly string[]) => [...new Set(refs)].sort();
    const scopeRefsCanonical = sortRefs(scopeRefs);
    const KIND_ORDER = ["behavior", "invariant", "failure_behavior"] as const;
    const normalizeRequirements = (items: readonly Record<string, unknown>[]) =>
      items.map((item): Record<string, unknown> => ({
        ...item,
        evidence_refs: sortRefs(item.evidence_refs as string[] ?? []),
        approved_scope_refs: sortRefs(item.approved_scope_refs as string[] ?? [])
      })).sort((left, right) =>
        KIND_ORDER.indexOf(left.kind as never) - KIND_ORDER.indexOf(right.kind as never) ||
        (String(left.requirement_id) < String(right.requirement_id) ? -1 : 1));
    const requirements = normalizeRequirements((input.structured_input.requirements ??
      requirementsFrom(input.approval.content, scopeRefsCanonical, evidenceRefs)) as Record<string, unknown>[]);
    const requirementRefs = sortRefs(requirements.map((item) => String(item.requirement_id)));
    const ownership = (input.structured_input.ownership ??
      [...new Set(input.structured_input.tasks.flatMap((task) => task.affected_paths as string[] ?? []))]
        .sort().map((path) => {
          const body = { path, approved_scope_refs: scopeRefsCanonical, evidence_refs: evidenceRefs };
          return { ownership_ref: stableId("ownership", body), ...body };
        }) as Record<string, unknown>[]).map((item): Record<string, unknown> => ({
      ...item,
      evidence_refs: sortRefs(item.evidence_refs as string[] ?? []),
      approved_scope_refs: sortRefs(item.approved_scope_refs as string[] ?? [])
    }));
    const ownershipRefs = sortRefs(ownership.map((item) => String(item.ownership_ref)));
    const taskIds = input.structured_input.tasks.map((task) => String(task.task_id));
    const scenarioIds = input.structured_input.scenarios.map((scenario) => String(scenario.scenario_id));
    // HP-12：task↔scenario 引用确定性闭包——显式引用 + 互逆补全，天然双向一致；
    // 闭包后仍为空的一侧回退全集（单任务无歧义才静默；多任务记密度警告）
    let fullFanout = false;
    const closedTaskRefs = new Map<string, Set<string>>();
    const closedScenarioRefs = new Map<string, Set<string>>();
    for (const taskId of taskIds) closedTaskRefs.set(taskId, new Set());
    for (const scenarioId of scenarioIds) closedScenarioRefs.set(scenarioId, new Set());
    for (const task of input.structured_input.tasks) {
      const taskId = String(task.task_id);
      for (const scenarioId of (task.scenario_refs as string[] | undefined) ?? []) {
        closedTaskRefs.get(taskId)?.add(scenarioId);
        closedScenarioRefs.get(scenarioId)?.add(taskId);
      }
    }
    for (const scenario of input.structured_input.scenarios) {
      const scenarioId = String(scenario.scenario_id);
      for (const taskId of (scenario.task_refs as string[] | undefined) ?? []) {
        closedScenarioRefs.get(scenarioId)?.add(taskId);
        closedTaskRefs.get(taskId)?.add(scenarioId);
      }
    }
    // 闭包后仍为空的一侧：对称回退（双向同时补全，保持一致性）
    for (const taskId of taskIds) {
      if ((closedTaskRefs.get(taskId)?.size ?? 0) === 0) {
        if (input.structured_input.tasks.length > 1) fullFanout = true;
        for (const scenarioId of scenarioIds) {
          closedTaskRefs.get(taskId)?.add(scenarioId);
          closedScenarioRefs.get(scenarioId)?.add(taskId);
        }
      }
    }
    for (const scenarioId of scenarioIds) {
      if ((closedScenarioRefs.get(scenarioId)?.size ?? 0) === 0) {
        if (input.structured_input.scenarios.length > 1 && input.structured_input.tasks.length > 1) {
          fullFanout = true;
        }
        for (const taskId of taskIds) {
          closedScenarioRefs.get(scenarioId)?.add(taskId);
          closedTaskRefs.get(taskId)?.add(scenarioId);
        }
      }
    }
    const deriveTaskScenarioRefs = (task: Record<string, unknown>): string[] =>
      [...(closedTaskRefs.get(String(task.task_id)) ?? new Set())];
    const deriveScenarioTaskRefs = (scenario: Record<string, unknown>): string[] =>
      [...(closedScenarioRefs.get(String(scenario.scenario_id)) ?? new Set())];
    const structured_input = {
      change_key: input.change_key,
      tasks: input.structured_input.tasks.map((task) => ({
        ...task,
        depends_on: sortRefs((task.depends_on as string[] | undefined) ?? []),
        decision_refs: sortRefs((task.decision_refs as string[] | undefined) ?? []),
        scenario_refs: sortRefs(deriveTaskScenarioRefs(task)),
        requirement_refs: sortRefs((task.requirement_refs as string[] | undefined)?.length
          ? task.requirement_refs as string[] : requirementRefs),
        evidence_refs: sortRefs((task.evidence_refs as string[] | undefined)?.length
          ? task.evidence_refs as string[] : evidenceRefs),
        ownership_refs: sortRefs((task.ownership_refs as string[] | undefined)?.length
          ? task.ownership_refs as string[] : ownershipRefs)
      })),
      scenarios: input.structured_input.scenarios.map((scenario) => ({
        ...scenario,
        task_refs: sortRefs(deriveScenarioTaskRefs(scenario)),
        requirement_refs: sortRefs((scenario.requirement_refs as string[] | undefined)?.length
          ? scenario.requirement_refs as string[] : requirementRefs)
      })),
      coverage: input.structured_input.coverage ?? coverageFrom(input.structured_input.scenarios),
      requirements,
      approved_scopes: approvedScopes,
      ownership
    };
    const human_input: HumanArtifactBuildInput = {
      schema_version: 2, profile, phase_set, context, intent, evidence, graph,
      approval_package, approval_package_input, approval_receipt, structured_input
    } as unknown as HumanArtifactBuildInput;
    const human = model.buildHumanArtifacts(human_input);
    const machine_input = { schema_version: 2 as const, profile, phase_set,
      capabilities: input.machine.capabilities as never, worktree_policy: input.machine.worktree_policy as never };
    const machine = model.deriveMachineArtifacts({ ...machine_input, human_input, human });
    const detail = model.deriveImplementationDetail({
      // HP-06：detail mode 唯一事实源是 profile.mode（分类结果）；自然输入的 mode 字段已弃用
      mode: profile.mode, human_input, human });
    const trusted = { human_input, human, machine_input, machine, detail };

    // 发布证据：文件来自产物，intent 由生产 renderer（事务层归一化）推导
    const renderer = createPlanFinalizationRenderer();
    const plan = await renderer.render({
      schema_version: 1,
      context: { change_key: input.change_key } as never,
      finalization: { quality_verification_input: { trusted } } as never
    });
    // staged 证据文件：frontmatter + 规范 JSON 序列化（质量层验证形态；
    // 实际发布字节由 renderer 的人类可读渲染承载，两者由 content_hash 绑定）
    const stagedArtifacts = [
      ["design.md", human.design, "markdown"],
      ["gate-policy.json", machine.gate_policy, "json"],
      ["implementation-checkpoints.json", machine.implementation_checkpoints, "json"],
      ["implementation-detail.md", detail, "markdown"],
      ["plan.md", human.plan, "markdown"],
      ["scenario-manifest.json", machine.scenario_manifest, "json"],
      ["test-scenarios.md", human.test_scenarios, "markdown"],
      ["worktree.json", machine.worktree, "json"]
    ] as const;
    const publication = {
      schema_version: 1 as const,
      stage_id: `stage:${input.change_key}`,
      publication_intent_id: plan.publication_intent_id,
      files: stagedArtifacts.map(([path, artifact, format]) => {
        const body = JSON.stringify(artifact);
        const serialized_content = format === "markdown"
          ? `---\nschema_version: 2\nartifact_type: ${(artifact as { artifact_type: string }).artifact_type}\ncontent_hash: ${(artifact as { content_hash: string }).content_hash}\n---\n${body}`
          : body;
        return {
          path,
          serialized_content,
          serialized_hash: `sha256:${createHash("sha256").update(canonicalJson(serialized_content)).digest("hex")}`,
          format
        };
      }),
      // staged 证据的 ownership = 源文件产品归属（任务 affected_paths 推导），
      // 与事务层 plan 归一化的八 target 所有权是两个语义层
      ownership_paths: ownership.map((item) => String((item as { path: string }).path)),
      approval_receipt_ref: approval_receipt.receipt_id,
      artifact_derivation_receipt_refs: [
        human.artifact_set_hash,
        machine.artifact_set_hash,
        detail.content_hash
      ]
    };

    const pack = {
      trusted,
      publication,
      context: {
        project_id: input.context.project_id,
        change_key: input.change_key,
        run_id: input.context.run_id,
        branch_name: input.context.branch_name,
        attempt: input.context.attempt
      },
      expected_baseline: input.expected_baseline
    };
    await writeFile(options.output, JSON.stringify(pack));
    dependencies.stdout(JSON.stringify({
      ok: true,
      code: "PLAN_EVIDENCE_PACK_BUILT",
      output: options.output,
      publication_intent_id: plan.publication_intent_id,
      approval_receipt_id: approval_receipt.receipt_id,
      ...(fullFanout ? { warnings: ["graph_density_full_fanout"] } : {})
    }) + "\n");
    return 0;
  } catch (error) {
    // HP-08：结构化信封——reason_code 取 core 稳定码，error 字段保留原 message
    const coreMessage = error instanceof Error ? error.message : String(error);
    const coreCode = /^PLAN[A-Z_]*$/u.test(coreMessage) ? coreMessage : undefined;
    return emitPlanError(dependencies.stdout, planErrorEnvelope({
      code: "PLAN_EVIDENCE_PACK_FAILED",
      reason_code: coreCode ?? "PLAN_EVIDENCE_PACK_FAILED",
      message: coreMessage,
      extra: { error: coreMessage }
    }));
  }
}
