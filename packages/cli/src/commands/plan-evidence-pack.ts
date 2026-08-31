import { createHash } from "node:crypto";

import { canonicalJson, isValidPlanRunId, LEGACY_PLAN_PHASE_ALIASES } from "@hunter-harness/contracts";

import { emitPlanError, planErrorEnvelope, planStageForCode } from "./plan-error.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  PLAN_PHASES,
  classifyPlan,
  configurePlannedPhases,
  createPlanArtifactModel,
  createPlanDecisionModule,
  createPlanningContextModule,
  type ApprovalContentInput,
  type HumanArtifactBuildInput,
  type PlanPhase,
  type PlanRiskSignal
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { createPlanFinalizationRenderer } from "../plan-finalization/production-ports.js";
import {
  createGitExec,
  probeGitCapabilities
} from "../plan-evidence/git-probe.js";
import {
  inferRiskSignals,
  parsePorcelainPaths
} from "../plan-evidence/risk-signal-inference.js";

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
  // narrow_fix/payment/permission/production_code/security/shared_state/user_visible_behavior。
  // 可留空数组：命令会按 affected_paths 与 git status 推断信号并与手填取并集，
  // 逐条标注来源（declared / inferred / declared+inferred），手填不能删除推断项。
  risk_signals: ["production_code"],
  mode: "standard",
  intent: {
    source_input: "<用户原话需求>",
    goal: "<一句话目标>",
    user_visible_outcome: "<用户能观察到的结果>",
    // 与 approval.content 的一致性规则：in_scope/out_of_scope 集合相等（顺序无关），
    // goal/user_visible_outcome 逐字相等（语义门禁逐字比较，差一个字都会在 finalize 被
    // semantic.goal_coverage 拦截）。approval 侧这四个字段都可整项省略、由命令从这里继承
    //（推荐：少抄一遍就少一次 drift）
    in_scope: ["<纳入范围条目>"],
    out_of_scope: ["<明确排除条目>"],
    constraints: [],
    // intent 要 2~5 条、approval 要 3~7 条，取 3 条同时满足
    acceptance_examples: ["<验收例子 1>", "<验收例子 2>", "<验收例子 3>"],
    // 非空时每一项都会生成未决决策 intent_uncertainty:<sha256(文本)>，必须在
    // decision_nodes 里提供同 id 的节点（冻结校验器硬要求），否则只能留空数组
    uncertainties: []
  },
  approval: {
    // 必须来自阶段 4 blocking confirmation 的真实结果，本命令不伪造审批。
    // decided_at 可选：省略取当前时间；有真实审批时刻时补 ISO 8601 字符串。
    content: {
      // goal/user_visible_outcome 已整项省略：从 intent 继承（warnings 会标
      // approval_goal_inherited）。显式给出时 goal/user_visible_outcome 必须与 intent
      // 逐字一致，in_scope/out_of_scope 集合一致；不一致在边界报 PLAN_GOAL_MISMATCH /
      // PLAN_SCOPE_MISMATCH，不必等到 finalize
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
        // 必须是文件形态的相对路径（正斜杠、不能以 / 结尾、不含 ./.. 段）；
        // 目录请改为列出其中的具体文件，目录路径会被 canonicalPath 拒绝
        affected_paths: ["<相对路径，如 src/module/file.ts>"],
        owner_phase: "execute"
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
        // P0/P1 = 必须带 ledger 证据；P2 = advisory。门禁按它判定哪些场景必须闭环。
        priority: "P0",
        // 这条场景在哪个阶段到期。execute 关门时 owner_phase=review/submit 的场景按计划顺延。
        owner_phase: "execute",
        // P0/P1 场景要么三元给全、要么整组省略；省略时 manifest 降为 schemaVersion 1，
        // 关门无法绑定结构化执行收据。
        executable_test_id: "<可执行测试 ID，如 unit::ut1>",
        test_file: "<测试文件相对路径>",
        test_title: "<测试用例标题>",
        verification_command: "<验证命令，可整条删除>"
      },
      {
        scenario_id: "<UT-002>",
        title: "<参数校验场景描述>",
        acceptance: "<可判定的通过标准>",
        coverage_dimension: "parameter_validation",
        execution_level: "unit",
        evidence_requirements: ["<证据要求，如 focused_test>"],
        risk_level: "low",
        priority: "P2",
        owner_phase: "execute"
      },
      {
        scenario_id: "<UT-003>",
        title: "<错误码场景描述>",
        acceptance: "<可判定的通过标准>",
        coverage_dimension: "error_codes",
        execution_level: "unit",
        evidence_requirements: ["<证据要求，如 focused_test>"],
        risk_level: "medium",
        priority: "P2",
        owner_phase: "execute"
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
    // goal/user_visible_outcome/in_scope/out_of_scope 未显式给出时从 intent 继承
    //（HP-14 scope / HP-16 goal；语义门禁逐字比较 goal、集合比较 scope，
    // 继承消掉“同一份内容抄两遍抄错”的纯往返）
    content: Omit<ApprovalContentInput, "in_scope" | "out_of_scope" | "goal" | "user_visible_outcome"> & {
      goal?: string;
      user_visible_outcome?: string;
      in_scope?: readonly string[];
      out_of_scope?: readonly string[];
    };
    approver_id: string;
    decided_at?: string;
  };
  decision_nodes?: readonly unknown[];
  /**
   * HP-15：对抗评审收据透传。评审必须在 evidence-pack 定稿后做（收据绑定
   * 产物内容哈希，重跑 evidence-pack 即失效）；推荐用 `plan review-record`
   * 由 CLI 内部算好 input_hash/findings_hash 写回，而不是手填这两个哈希。
   */
  adversarial_review?: {
    readonly schema_version: 1;
    readonly reviewer_identity: string;
    readonly review_mode: "inline" | "delegated";
    readonly input_hash: string;
    readonly findings_hash: string;
    readonly findings: readonly Record<string, unknown>[];
    readonly completed_at: string;
  };
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
  "evidence_requirements", "risk_level", "priority", "owner_phase"] as const;
const SCENARIO_OPTIONAL_KEYS = ["verification_command", "task_refs", "requirement_refs",
  "executable_test_id", "test_file", "test_title"] as const;
const EXECUTION_LEVELS = ["unit", "api", "data_compatibility", "integration", "system"] as const;
const RISK_LEVELS = ["low", "medium", "high"] as const;
const SCENARIO_PRIORITIES = ["P0", "P1", "P2"] as const;
const WORKTREE_POLICIES = ["project_default", "required", "forbidden"] as const;

// 与冻结模块同源的契约常量（core 只抛无定位信息的稳定码，边界负责提前报清）
const INTENT_REQUIRED_KEYS = ["source_input", "goal", "user_visible_outcome", "in_scope",
  "out_of_scope", "acceptance_examples"] as const;
const INTENT_OPTIONAL_KEYS = ["constraints", "uncertainties"] as const;
const APPROVAL_KEYS = ["content", "approver_id"] as const;
const APPROVAL_OPTIONAL_KEYS = ["decided_at"] as const;
const APPROVAL_CONTENT_REQUIRED_KEYS = ["recommended_design",
  "key_alternatives", "invariants", "failure_behaviors", "compatibility_boundaries", "risks",
  "acceptance_examples"] as const;
// goal/user_visible_outcome 与 in_scope/out_of_scope 一样可从 intent 继承，故不是必填键
const APPROVAL_CONTENT_INHERITABLE_KEYS = ["goal", "user_visible_outcome", "in_scope",
  "out_of_scope"] as const;
const DECISION_NODE_KEYS = ["schema_version", "decision_id", "decision_version", "type",
  "depends_on", "status", "tradeoffs", "affected_behaviors", "evidence_refs"] as const;
const DECISION_NODE_OPTIONAL_KEYS = ["question", "recommendation", "recommendation_reason",
  "resolution", "resolved_by", "resolved_at"] as const;
const DECISION_NODE_TYPES = ["fact", "engineering_default", "product_decision", "risk_decision"] as const;
const DECISION_NODE_STATUSES = ["pending", "resolved", "blocked", "superseded"] as const;
const REVIEW_RECEIPT_KEYS = ["schema_version", "reviewer_identity", "review_mode", "input_hash",
  "findings_hash", "findings", "completed_at"] as const;
const REVIEW_MODES = ["inline", "delegated"] as const;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const IDENTITY_PATTERN = /^[a-z][a-z0-9_.:-]{0,159}$/u;

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

/** 字符串数组通用校验：条数上下限 + 非空字符串 + 去重（与 core strings() 同源）。 */
function stringArrayProblem(value: unknown, fieldPath: string, minimum: number,
  maximum: number): InputProblem | undefined {
  if (!Array.isArray(value)) return { field_path: fieldPath, message: "必须是字符串数组" };
  if (value.length < minimum || value.length > maximum) {
    return { field_path: fieldPath, message: `必须是 ${minimum}~${maximum} 条（当前 ${value.length} 条）` };
  }
  const badIndex = value.findIndex((item) => typeof item !== "string" || item.trim() === "");
  if (badIndex >= 0) {
    return { field_path: `${fieldPath}[${badIndex}]`, message: "必须是非空字符串" };
  }
  if (new Set(value).size !== value.length) {
    return { field_path: fieldPath, message: "条目必须互不相同（冻结校验器要求去重）" };
  }
  return undefined;
}

/** 与 core plan-artifacts 的 canonicalPath 同源：相对、正斜杠、NFC、无空段/./.. 。 */
function isCanonicalPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && value === value.normalize("NFC") &&
    !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/u.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** 与 core planning-context 的 stableHash 同源（canonical JSON 的 sha256）。 */
function stableHashHex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
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

  // intent 层：键集 + 条数上下限（冻结模块只抛 PLANNING_INTENT_INVALID，无定位信息）
  const intentValue: unknown = input.intent;
  if (!isRecord(intentValue)) {
    problems.push({ field_path: "intent", message: "必须是对象" });
  } else {
    const keyProblem = keySetProblem(intentValue, "intent",
      [...INTENT_REQUIRED_KEYS], [...INTENT_REQUIRED_KEYS, ...INTENT_OPTIONAL_KEYS]);
    if (keyProblem !== undefined) problems.push(keyProblem);
    if ("acceptance_examples" in intentValue) {
      const countProblem = stringArrayProblem(intentValue.acceptance_examples,
        "intent.acceptance_examples", 2, 5);
      if (countProblem !== undefined) problems.push(countProblem);
    }
    if ("in_scope" in intentValue) {
      const scopeProblem = stringArrayProblem(intentValue.in_scope, "intent.in_scope", 1, 32);
      if (scopeProblem !== undefined) problems.push(scopeProblem);
    }
    if ("out_of_scope" in intentValue) {
      const scopeProblem = stringArrayProblem(intentValue.out_of_scope, "intent.out_of_scope", 0, 32);
      if (scopeProblem !== undefined) problems.push(scopeProblem);
    }
    if ("uncertainties" in intentValue) {
      const uncertaintyProblem = stringArrayProblem(intentValue.uncertainties,
        "intent.uncertainties", 0, 16);
      if (uncertaintyProblem !== undefined) problems.push(uncertaintyProblem);
    }
  }

  // approval 层：content 键集 + 各内容数组条数（缺失的可继承键由继承逻辑补，不算问题）
  const approvalValue: unknown = input.approval;
  if (!isRecord(approvalValue)) {
    problems.push({ field_path: "approval", message: "必须是对象" });
  } else {
    const keyProblem = keySetProblem(approvalValue, "approval",
      [...APPROVAL_KEYS], [...APPROVAL_KEYS, ...APPROVAL_OPTIONAL_KEYS]);
    if (keyProblem !== undefined) problems.push(keyProblem);
    const content: unknown = approvalValue.content;
    if ("content" in approvalValue) {
      if (!isRecord(content)) {
        problems.push({ field_path: "approval.content", message: "必须是对象" });
      } else {
        const contentKeyProblem = keySetProblem(content, "approval.content",
          [...APPROVAL_CONTENT_REQUIRED_KEYS],
          [...APPROVAL_CONTENT_REQUIRED_KEYS, ...APPROVAL_CONTENT_INHERITABLE_KEYS]);
        if (contentKeyProblem !== undefined) problems.push(contentKeyProblem);
        for (const [key, minimum, maximum] of [["acceptance_examples", 3, 7],
          ["key_alternatives", 1, 16], ["invariants", 1, 32], ["failure_behaviors", 1, 32],
          ["compatibility_boundaries", 1, 32]] as const) {
          if (!(key in content)) continue;
          const countProblem = stringArrayProblem(content[key], `approval.content.${key}`, minimum, maximum);
          if (countProblem !== undefined) problems.push(countProblem);
        }
        if ("in_scope" in content) {
          const scopeProblem = stringArrayProblem(content.in_scope, "approval.content.in_scope", 1, 32);
          if (scopeProblem !== undefined) problems.push(scopeProblem);
        }
        if ("out_of_scope" in content) {
          const scopeProblem = stringArrayProblem(content.out_of_scope, "approval.content.out_of_scope", 0, 32);
          if (scopeProblem !== undefined) problems.push(scopeProblem);
        }
        const risks: unknown = content.risks;
        if ("risks" in content) {
          if (!Array.isArray(risks) || risks.length > 16) {
            problems.push({ field_path: "approval.content.risks", message: "必须是不超过 16 条的数组" });
          } else {
            risks.forEach((risk, index) => {
              if (!isRecord(risk) || keySetProblem(risk, `approval.content.risks[${index}]`,
                ["risk", "mitigation"], ["risk", "mitigation"]) !== undefined) {
                problems.push({ field_path: `approval.content.risks[${index}]`,
                  message: "必须是且只含 risk/mitigation 两个字符串字段的对象" });
              }
            });
          }
        }
      }
    }
  }
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
      } else if (Array.isArray(task.affected_paths)) {
        // canonicalPath 拒目录形态（尾斜杠产生空段）与 Windows 反斜杠/盘符——
        // 冻结模块只抛 PLAN_ARTIFACT_INPUT_INVALID，这里逐条给定位与写法说明
        task.affected_paths.forEach((affectedPath, pathIndex) => {
          if (!isCanonicalPath(affectedPath)) {
            problems.push({
              field_path: `${path}.affected_paths[${pathIndex}]`,
              message: "必须是相对文件路径（正斜杠分隔、不能以 / 结尾、不含 ./.. 段、不接受盘符/绝对路径）；目录请改为列出其中的具体文件"
            });
          }
        });
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
        ["execution_level", EXECUTION_LEVELS], ["risk_level", RISK_LEVELS],
        ["priority", SCENARIO_PRIORITIES], ["owner_phase", PLAN_PHASES]] as const) {
        const problem = enumProblem(scenario, key, path, allowed);
        if (problem !== undefined) problems.push(problem);
      }
      // P0/P1 是 ledger 场景：缺可执行三元时派生的 manifest 只能声明 schemaVersion 1，
      // run/test 关门时绑不上结构化执行收据。在边界上说清楚，不要等到关门才发现。
      if (scenario.priority === "P0" || scenario.priority === "P1") {
        const missing = (["executable_test_id", "test_file", "test_title"] as const)
          .filter((key) => typeof scenario[key] !== "string" || scenario[key].trim() === "");
        if (missing.length > 0 && missing.length < 3) {
          problems.push({
            field_path: path,
            missing_keys: missing,
            message: "P0/P1 场景的可执行测试三元要么整组给全，要么整组省略"
          });
        }
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

  // 决策层：节点键集/枚举/状态一致性；uncertainties 生成的未决决策必须被节点覆盖。
  // 冻结模块只抛 PLAN_DECISION_INPUT_INVALID（无定位），高频错全在这里提前报。
  const decisionNodes: unknown = input.decision_nodes;
  const decisionIds = new Set<string>();
  if (decisionNodes !== undefined && !Array.isArray(decisionNodes)) {
    problems.push({ field_path: "decision_nodes", message: "必须是数组" });
  } else if (decisionNodes !== undefined) {
    (decisionNodes as unknown[]).forEach((node, index) => {
      const path = `decision_nodes[${index}]`;
      if (!isRecord(node)) {
        problems.push({ field_path: path, message: "必须是对象" });
        return;
      }
      const keyProblem = keySetProblem(node, path, DECISION_NODE_KEYS,
        [...DECISION_NODE_KEYS, ...DECISION_NODE_OPTIONAL_KEYS]);
      if (keyProblem !== undefined) problems.push(keyProblem);
      if (node.schema_version !== 1) {
        problems.push({ field_path: `${path}.schema_version`, message: "必须是 1" });
      }
      const typeProblem = enumProblem(node, "type", path, DECISION_NODE_TYPES);
      if (typeProblem !== undefined) problems.push(typeProblem);
      const statusProblem = enumProblem(node, "status", path, DECISION_NODE_STATUSES);
      if (statusProblem !== undefined) problems.push(statusProblem);
      const resolvedByProblem = enumProblem(node, "resolved_by", path,
        ["evidence", "engineering_default", "user"]);
      if (resolvedByProblem !== undefined) problems.push(resolvedByProblem);
      if (typeof node.decision_id === "string" && node.decision_id !== "") {
        if (decisionIds.has(node.decision_id)) {
          problems.push({ field_path: `${path}.decision_id`, message: `决策标识重复：${node.decision_id}` });
        }
        decisionIds.add(node.decision_id);
      }
      if (typeof node.decision_version !== "number" ||
        !Number.isSafeInteger(node.decision_version) || node.decision_version < 1) {
        problems.push({ field_path: `${path}.decision_version`, message: "必须是 ≥1 的整数" });
      }
      const expectedResolver = node.type === "fact" ? "evidence" : node.type === "engineering_default"
        ? "engineering_default" : "user";
      if (node.status === "resolved") {
        for (const key of ["resolution", "resolved_by", "resolved_at"] as const) {
          if (!(key in node)) {
            problems.push({ field_path: path, missing_keys: [key],
              message: "status=resolved 的节点必须带 resolution/resolved_by/resolved_at 三元" });
          }
        }
        if (node.resolved_by !== undefined && node.resolved_by !== expectedResolver) {
          problems.push({ field_path: `${path}.resolved_by`,
            message: `type=${String(node.type)} 的节点 resolved_by 必须是 ${expectedResolver}` });
        }
      }
      if ((node.type === "product_decision" || node.type === "risk_decision") &&
        node.status !== "resolved" &&
        (node.resolution !== undefined || node.resolved_by !== undefined || node.resolved_at !== undefined)) {
        problems.push({ field_path: path,
          message: "未 resolved 的 product_decision/risk_decision 不得携带 resolution/resolved_by/resolved_at" });
      }
    });
  }
  if (isRecord(intentValue) && Array.isArray(intentValue.uncertainties) &&
    intentValue.uncertainties.every((item) => typeof item === "string")) {
    const expectedIds = (intentValue.uncertainties as string[]).map((uncertainty) =>
      `intent_uncertainty:${stableHashHex(uncertainty)}`);
    const missing = expectedIds.filter((id) => !decisionIds.has(id));
    if (missing.length > 0) {
      problems.push({
        field_path: "intent.uncertainties",
        message: "非空 uncertainty 会生成未决决策，必须在 decision_nodes 提供同 id 节点；缺失：" +
          missing.join(", ")
      });
    }
  }

  // HP-15：adversarial_review 若透传，先验形状（finalize 的绑定失败才是语义层的事）
  const review: unknown = input.adversarial_review;
  if (review !== undefined) {
    if (!isRecord(review)) {
      problems.push({ field_path: "adversarial_review", message: "必须是对象" });
    } else {
      const keyProblem = keySetProblem(review, "adversarial_review", REVIEW_RECEIPT_KEYS, REVIEW_RECEIPT_KEYS);
      if (keyProblem !== undefined) problems.push(keyProblem);
      if (review.schema_version !== 1) {
        problems.push({ field_path: "adversarial_review.schema_version", message: "必须是 1" });
      }
      if (typeof review.reviewer_identity !== "string" ||
        !IDENTITY_PATTERN.test(review.reviewer_identity)) {
        problems.push({ field_path: "adversarial_review.reviewer_identity",
          message: "必须匹配 ^[a-z][a-z0-9_.:-]{0,159}$（如 inline:<标识>）" });
      }
      const modeProblem = enumProblem(review, "review_mode", "adversarial_review", REVIEW_MODES);
      if (modeProblem !== undefined) problems.push(modeProblem);
      for (const key of ["input_hash", "findings_hash"] as const) {
        if (typeof review[key] !== "string" || !SHA256_PATTERN.test(review[key])) {
          problems.push({ field_path: `adversarial_review.${key}`,
            message: "必须是 sha256:<64 位小写十六进制>" });
        }
      }
      if (!Array.isArray(review.findings)) {
        problems.push({ field_path: "adversarial_review.findings", message: "必须是数组" });
      }
      if (typeof review.completed_at !== "string" ||
        !Number.isFinite(Date.parse(review.completed_at))) {
        problems.push({ field_path: "adversarial_review.completed_at",
          message: "必须是可解析的 ISO 8601 时间" });
      }
    }
  }
  return problems;
}

const stableId = (prefix: string, body: unknown): string =>
  `${prefix}:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;


/**
 * 阶段 0.6 的 plannedPhases 接缝 + 门禁权威快照：读 configure-plan 落在
 * `.harness/changes/<change_key>/meta/gate-policy.json` 的阶段计划与门禁字段。
 *
 * 权威形状校验：顶层 `plannedPhases` 必须是字符串数组——v2 包装体（同名不同形，
 * reference.md:377 警告过）、坏 JSON、文件缺失一律回退 derived。旧阶段名经
 * LEGACY_PLAN_PHASE_ALIASES 归一并保序去重（与 Python `_phase_plan` 同语义）；
 * 出现未知阶段名视为整份计划不可读（fail-safe 回退 derived，与 Python 降级同向）。
 *
 * `document` 是原样文档（门禁权威快照的原料）：requiredGateDag /
 * requiredValidationsByPhase 等由调用方按白名单并入 v2 gate_policy。
 */
interface GatePolicySnapshot {
  readonly plannedPhases: readonly PlanPhase[];
  readonly document: Record<string, unknown>;
}

async function readGatePolicySnapshot(
  cwd: string,
  changeKey: string
): Promise<GatePolicySnapshot | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(join(cwd, ".harness", "changes", changeKey, "meta", "gate-policy.json"), "utf8")
    );
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  const planned: unknown = raw.plannedPhases;
  if (!Array.isArray(planned) || !planned.every((item) => typeof item === "string")) {
    return undefined;
  }
  const mapped = (planned as string[]).map(
    (name) => (LEGACY_PLAN_PHASE_ALIASES as Record<string, string>)[name] ?? name
  );
  if (mapped.some((name) => !(PLAN_PHASES as readonly string[]).includes(name))) {
    return undefined;
  }
  return { plannedPhases: [...new Set(mapped as PlanPhase[])], document: raw };
}

/** 旧契约的 requiredValidationsByPhase 键（run/test）归一到 execute 并取并集。 */
function canonicalValidationsByPhase(
  value: unknown
): Record<string, readonly string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const merged: Record<string, string[]> = {};
  for (const [key, validations] of Object.entries(value)) {
    if (!Array.isArray(validations) || !validations.every((item) => typeof item === "string")) {
      return undefined;
    }
    const canonical = (LEGACY_PLAN_PHASE_ALIASES as Record<string, string>)[key] ?? key;
    if (!(PLAN_PHASES as readonly string[]).includes(canonical)) continue;
    const bucket = merged[canonical] ?? [];
    for (const item of validations as string[]) {
      if (!bucket.includes(item)) bucket.push(item);
    }
    merged[canonical] = bucket;
  }
  return merged;
}


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
        message: "run_id 必须满足 ^[a-z][a-z0-9_.:-]{0,159}$（小写字母开头，如 plan_<uuid>）；" +
          `收到 ${JSON.stringify(input.context?.run_id)}`
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
    // HP-14/HP-16：approval.content 的 in_scope/out_of_scope 与 goal/user_visible_outcome
    // 未显式给出时从 intent 继承（两边语义门禁要求一致；继承消掉“同一份内容抄两遍抄错”
    // 的纯往返，不伪造审批——继承值就是编排方在阶段 4 确认过的同一份内容）
    const scopeInherited: string[] = [];
    const goalInherited: string[] = [];
    const approvalContent = input.approval.content;
    if (approvalContent.in_scope === undefined) {
      (approvalContent as { in_scope: readonly string[] }).in_scope = [...input.intent.in_scope];
      scopeInherited.push("in_scope");
    }
    if (approvalContent.out_of_scope === undefined) {
      (approvalContent as { out_of_scope: readonly string[] }).out_of_scope =
        [...input.intent.out_of_scope];
      scopeInherited.push("out_of_scope");
    }
    if (approvalContent.goal === undefined) {
      (approvalContent as { goal: string }).goal = input.intent.goal;
      goalInherited.push("goal");
    }
    if (approvalContent.user_visible_outcome === undefined) {
      (approvalContent as { user_visible_outcome: string }).user_visible_outcome =
        input.intent.user_visible_outcome;
      goalInherited.push("user_visible_outcome");
    }
    // 继承后 content 已完整（边界校验 + 继承保证四个可继承字段存在）
    const completedApprovalContent = approvalContent as ApprovalContentInput;
    // HP-16：goal/user_visible_outcome 显式给出时必须与 intent 逐字一致——core 语义门禁
    //（semantic.goal_coverage）就是逐字比较；在边界提前报清，不再等到 finalize 才 blocked
    if (completedApprovalContent.goal !== input.intent.goal ||
        completedApprovalContent.user_visible_outcome !== input.intent.user_visible_outcome) {
      return emitPlanError(dependencies.stdout, planErrorEnvelope({
        code: "PLAN_GOAL_MISMATCH",
        field_path: "approval.content.goal",
        message: "approval.content 的 goal/user_visible_outcome 必须与 intent 逐字一致；" +
          "两个字段都可整项省略，由命令从 intent 继承",
        extra: {
          diff: {
            goal: { intent: input.intent.goal, approval: completedApprovalContent.goal },
            user_visible_outcome: {
              intent: input.intent.user_visible_outcome,
              approval: completedApprovalContent.user_visible_outcome
            }
          }
        }
      }));
    }
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

    // capabilities 真实化：从真实仓库状态探测（不再是写死的三个布尔）。
    // uses_worktree = 身在 worktree 或 worktree_policy=required（计划要求 worktree
    // 时 configuration.ts 也会补 merge 阶段），provenance 只进 stdout 与 pack.context。
    const gitExec = dependencies.gitExec ?? createGitExec();
    const probe = await probeGitCapabilities(dependencies.cwd, gitExec);
    const usesWorktree = probe.uses_worktree || input.machine.worktree_policy === "required";
    const capabilitiesProvenance = {
      probe: probe.provenance,
      uses_worktree: probe.uses_worktree
        ? "probe"
        : input.machine.worktree_policy === "required"
          ? "worktree_policy"
          : "probe"
    };

    // risk_signals 推断层：affected_paths（主源）+ git status（次源），
    // 与手填取并集并逐条标注来源——推断是安全地板，手填不可删推断项。
    let gitStatusPaths: string[] | undefined;
    if (probe.is_git) {
      try {
        const statusOutput = await gitExec(
          ["status", "--porcelain", "--untracked-files=all"], dependencies.cwd
        );
        gitStatusPaths = parsePorcelainPaths(statusOutput);
      } catch {
        gitStatusPaths = undefined;
      }
    }
    const affectedPaths = input.structured_input.tasks.flatMap((task) =>
      Array.isArray(task.affected_paths) ? task.affected_paths.map(String) : []
    );
    const signalInference = inferRiskSignals({
      declared: (input.risk_signals ?? []) as PlanRiskSignal[],
      affectedPaths,
      gitStatusPaths
    });

    const profile = classifyPlan({ schema_version: 1, change_id: input.change_key,
      risk_signals: [...signalInference.effective], created_at: createdAt });

    // 阶段 0.6 接缝：configure-plan 落的 plannedPhases 不再被忽略。
    // 可选阶段取 planned ∩ optional；optional − planned 记为显式省略（绝不含 required，
    // 否则 outcome 翻 not_publishable）；planned 缺 required 时 required 仍保留并告警。
    const gateSnapshot = await readGatePolicySnapshot(dependencies.cwd, input.change_key);
    const gatePlanned = gateSnapshot?.plannedPhases;
    const phaseSetSource = gatePlanned === undefined ? "derived" : "gate-policy";
    const requestedOptional = gatePlanned === undefined
      ? []
      : profile.optional_phases.filter((phase) => gatePlanned.includes(phase));
    const requestedOmissions = gatePlanned === undefined
      ? []
      : profile.optional_phases.filter((phase) => !gatePlanned.includes(phase));
    const requiredRetained = gatePlanned === undefined
      ? []
      : profile.required_phases.filter((phase) => !gatePlanned.includes(phase));

    const phase_set = configurePlannedPhases(profile, { schema_version: 1,
      is_git: probe.is_git, has_remote: probe.has_remote,
      uses_worktree: usesWorktree, available_phases: PLAN_PHASES,
      requested_optional_phases: [...requestedOptional],
      requested_omissions: [...requestedOmissions], configured_at: createdAt });
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
    const approval_package_input = { content: completedApprovalContent, created_at: createdAt };
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
      requirementsFrom(completedApprovalContent, scopeRefsCanonical, evidenceRefs)) as Record<string, unknown>[]);
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
    // 门禁权威快照：classify 在 0.5 落的 DAG/tier/source 与 0.6 计划一并并入
    // v2 gate_policy content（白名单键，哈希绑定）——gate 侧由此可优先读
    // plan-profile.json，工作副本（meta/gate-policy.json）降级为回退。
    const gatePolicyOverlay = gateSnapshot === undefined
      ? undefined
      : {
          ...(typeof gateSnapshot.document.tier === "string"
            ? { tier: gateSnapshot.document.tier } : {}),
          ...(typeof gateSnapshot.document.source === "string"
            ? { source: gateSnapshot.document.source } : {}),
          ...(gateSnapshot.document.requiredGateDag !== undefined
            ? { required_gate_dag: gateSnapshot.document.requiredGateDag } : {}),
          ...(canonicalValidationsByPhase(gateSnapshot.document.requiredValidationsByPhase) !== undefined
            ? { required_validations_by_phase:
                canonicalValidationsByPhase(gateSnapshot.document.requiredValidationsByPhase) }
            : {}),
          phase_set_source: phaseSetSource
        };
    const machine_input = { schema_version: 2 as const, profile, phase_set,
      capabilities: input.machine.capabilities as never, worktree_policy: input.machine.worktree_policy as never,
      ...(gatePolicyOverlay === undefined ? {} : { gate_policy_overlay: gatePolicyOverlay }) };
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
        attempt: input.context.attempt,
        // provenance 标注只进 context（非哈希身份区）：审计能看到哪些信号是推断的、
        // capabilities 来自探针还是不可用回退、phase_set 来自 0.6 计划还是派生。
        capabilities_provenance: capabilitiesProvenance,
        signal_provenance: signalInference.provenance,
        phase_set_source: phaseSetSource
      },
      expected_baseline: input.expected_baseline,
      // HP-15：对抗评审收据透传。收据绑定本 pack 的产物哈希，任何字段变化后
      // 必须重跑评审/重新签发收据（plan review-record 可代算两个哈希）。
      ...(input.adversarial_review === undefined
        ? {}
        : { adversarial_review: input.adversarial_review })
    };
    await writeFile(options.output, JSON.stringify(pack));
    const warnings: string[] = [
      ...(fullFanout ? ["graph_density_full_fanout"] : []),
      ...(requiredRetained.length > 0 ? ["phase_set_required_retained"] : []),
      ...(scopeInherited.length > 0 ? [`approval_scope_inherited:${scopeInherited.join(",")}`] : []),
      ...(goalInherited.length > 0 ? [`approval_goal_inherited:${goalInherited.join(",")}`] : [])
    ];
    dependencies.stdout(JSON.stringify({
      ok: true,
      code: "PLAN_EVIDENCE_PACK_BUILT",
      output: options.output,
      publication_intent_id: plan.publication_intent_id,
      approval_receipt_id: approval_receipt.receipt_id,
      phase_set_source: phaseSetSource,
      capabilities_provenance: capabilitiesProvenance,
      signal_provenance: signalInference.provenance,
      ...(warnings.length > 0 ? { warnings } : {})
    }) + "\n");
    return 0;
  } catch (error) {
    // HP-08：结构化信封——reason_code 取 core 稳定码，error 字段保留原 message；
    // stage 按 core 码推导（信封码 PLAN_EVIDENCE_PACK_FAILED 只会落到 finalize，误导定位）
    const coreMessage = error instanceof Error ? error.message : String(error);
    const coreCode = /^PLAN[A-Z_]*$/u.test(coreMessage) ? coreMessage : undefined;
    return emitPlanError(dependencies.stdout, planErrorEnvelope({
      code: "PLAN_EVIDENCE_PACK_FAILED",
      stage: coreCode === undefined ? "finalize" : planStageForCode(coreCode),
      reason_code: coreCode ?? "PLAN_EVIDENCE_PACK_FAILED",
      message: coreMessage,
      extra: { error: coreMessage }
    }));
  }
}
