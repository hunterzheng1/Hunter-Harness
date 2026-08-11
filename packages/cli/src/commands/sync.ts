import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  assessCodebaseMapOnDisk,
  runManagedProcess,
  type ManagedProcessBudget,
  type ManagedProcessResult,
  refreshProject,
  validateInstructionGraph
} from "@hunter-harness/core";
import {
  HARNESS_AGENT_ORDER,
  type CodeBuddySurface,
  type HarnessAgent
} from "@hunter-harness/contracts";

import type { CommandDependencies } from "./configure.js";
import { inspectConfigOrigins } from "./config-origins.js";
import { detectProject } from "./refresh.js";
import { resolvePythonRuntime, type PythonRuntimeResolution } from "../runtime/python.js";
import { assessCodeGraphStatus } from "../sync/codegraph-status.js";
import { observeGitDelta } from "../sync/git-delta.js";
import {
  assessWorkflowCompatibility,
  CLI_CAPABILITIES
} from "../workflow-data/compatibility.js";
import { readWorkflowFamilyManifest } from "../workflow-data/resolve.js";
import { readCliVersion } from "../version.js";

export interface SyncCommandOptions {
  project?: string;
  profile?: string;
  json?: boolean;
  dryRun?: boolean;
  check?: boolean;
  apply?: "safe";
  fix?: string;
  yes?: boolean;
  verbose?: boolean;
  includeComponents?: boolean;
  progress?: "jsonl" | "text" | "none";
}

export type SyncStatus =
  | "OK"
  | "ADVISORY"
  | "WARN"
  | "FAIL"
  | "BLOCKED"
  | "UNKNOWN";

export interface ComponentReceipt {
  component: string;
  status: SyncStatus;
  reasonCode: string;
  observedAt: string;
  durationMs: number;
  inputHash: string | null;
  outputHash: string | null;
  evidence: string[];
  autoFixed: boolean;
  nextAction: string | null;
  effects?: {
    persisted: string[];
    notPersisted: string[];
  };
  details?: unknown;
}

export interface SyncRemediation {
  id: string;
  component: string;
  severity: "ADVISORY" | "WARN" | "FAIL";
  title: string;
  autoFixable: boolean;
  risk: "low" | "medium" | "high";
  writes: string[];
  backup: string | null;
  rollback: string | null;
  estimatedDurationMs: number | null;
  requiresConfirmation: boolean;
  previewCommand: string;
  applyCommand: string;
  affectedCount?: number;
}

export interface SyncVersions {
  cliVersion: string;
  workflowBundleVersion: string | null;
  adapterBundleVersions: Record<string, string>;
}

export type ProcessResult = ManagedProcessResult;
export type ProcessBudget = ManagedProcessBudget;

function nowIso(): string {
  return new Date().toISOString();
}

export async function runProcess(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  onStderr: (value: string) => void,
  budgetInput: number | ProcessBudget = 15 * 60 * 1000
): Promise<ProcessResult> {
  return runManagedProcess(argv, cwd, env, onStderr, budgetInput);
}

function configuredAgents(values: readonly string[]): HarnessAgent[] {
  const enabled = new Set(values);
  return HARNESS_AGENT_ORDER.filter((agent) => enabled.has(agent));
}

function instructionEntrypointsForAgents(agents: readonly HarnessAgent[]): string[] {
  const entrypoints = new Set(["AGENTS.md"]);
  if (agents.includes("claude-code")) entrypoints.add("CLAUDE.md");
  if (agents.includes("codebuddy")) entrypoints.add("CODEBUDDY.md");
  return [...entrypoints];
}

function receipt(
  component: string,
  startedAt: number,
  status: SyncStatus,
  reasonCode: string,
  details?: unknown,
  nextAction?: string | null,
  effects?: ComponentReceipt["effects"]
): ComponentReceipt {
  return {
    component,
    status,
    reasonCode,
    observedAt: nowIso(),
    durationMs: Date.now() - startedAt,
    inputHash: null,
    outputHash: null,
    evidence: [],
    autoFixed: false,
    nextAction: nextAction ?? defaultSyncNextAction(component, status, reasonCode),
    ...(effects === undefined ? {} : { effects }),
    ...(details === undefined ? {} : { details })
  };
}

function defaultSyncNextAction(
  component: string,
  status: SyncStatus,
  reasonCode: string
): string | null {
  if (status === "OK") return null;
  if (component === "adapter-projection") {
    return "检查已保留的 Adapter 变更；如需采纳，先更新 `harness/` 真源并运行聚焦测试，再刷新投影。不要直接覆盖本地 Adapter 文件。";
  }
  if (component === "runtime:python") {
    return "安装或选择可用的 Python 运行时，然后重新运行 `npx hunter-harness sync`。";
  }
  if (reasonCode === "DRY_RUN_NOT_EXECUTED") {
    return "确认预览结果后，去掉 `--dry-run` 重新运行 `npx hunter-harness sync`。";
  }
  if (component === "codebase-map") {
    return "运行 `/harness-codebase-map`，生成技术栈、架构、目录结构、约定、测试与风险等项目地图。";
  }
  if (component === "instruction-graph") {
    return "检查当前已启用 Agent 的入口文档及其引用，修复缺失文件、无效引用或循环引用后重新同步。";
  }
  return `处理 ${component} 的“${reasonCode}”问题后，重新运行 \`npx hunter-harness sync\`。`;
}

interface AdapterConflictEvidence {
  source_path: string;
  target_path: string;
  source_content_sha256?: string | null;
  adapter_content_sha256?: string | null;
  baseline_content_sha256?: string | null;
  old_sha256?: string | null;
  incoming_sha256?: string | null;
  diff_summary?: unknown;
}

export function buildPromoteCandidates(
  conflicts: readonly AdapterConflictEvidence[]
): Array<{
  candidateId: string;
  patchHash: string;
  adapterTargets: string[];
  sourcePaths: string[];
  proposal: {
    status: "PROPOSED";
    steps: readonly string[];
  };
}> {
  const grouped = new Map<string, AdapterConflictEvidence[]>();
  for (const conflict of conflicts) {
    const patchHash = conflict.adapter_content_sha256 ?? conflict.old_sha256;
    if (patchHash === null || patchHash === undefined) continue;
    grouped.set(patchHash, [...(grouped.get(patchHash) ?? []), conflict]);
  }
  return [...grouped.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([patchHash, entries]) => ({
      candidateId: `adapter-patch-${patchHash.slice(0, 12)}`,
      patchHash,
      adapterTargets: entries.map((entry) => entry.target_path).sort(),
      sourcePaths: [...new Set(entries.map((entry) => entry.source_path))].sort(),
      proposal: {
        status: "PROPOSED" as const,
        steps: [
          "Review the shared adapter patch and confirm its intended behavior.",
          "Apply the approved change to the matching harness/ source file(s).",
          "Run focused source tests and refresh adapters without force-overwriting local edits."
        ]
      }
    }))
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

export function summarizePartialEffects(
  components: readonly ComponentReceipt[]
): {
  persisted: string[];
  notPersisted: string[];
  summary: string;
} {
  const persisted = components.flatMap((component) => component.effects?.persisted ?? []);
  const notPersisted = components.flatMap((component) => component.effects?.notPersisted ?? []);
  return {
    persisted,
    notPersisted,
    summary: persisted.length === 0
      ? "本次同步没有产生持久化变更。"
      : `已持久化：${persisted.join("；")}。${notPersisted.length === 0 ? "" : `未持久化：${notPersisted.join("；")}。`}`
  };
}

function overallStatus(components: readonly ComponentReceipt[]): SyncStatus {
  if (components.some((item) => item.status === "BLOCKED")) return "BLOCKED";
  if (components.some((item) => item.status === "FAIL")) return "FAIL";
  if (components.some((item) => item.status === "WARN")) return "WARN";
  if (components.some((item) => item.status === "UNKNOWN")) return "WARN";
  if (components.some((item) => item.status === "ADVISORY")) return "ADVISORY";
  return "OK";
}

function statusCounts(components: readonly ComponentReceipt[]): Record<string, number> {
  return Object.fromEntries(
    (["OK", "ADVISORY", "WARN", "FAIL", "BLOCKED", "UNKNOWN"] as const).map((status) => [
      status.toLowerCase(),
      components.filter((item) => item.status === status).length
    ])
  );
}

function adapterName(targetPath: string): string {
  const match = /^\.(agents|claude|codebuddy|cursor)(?:\/|$)/.exec(
    targetPath.replaceAll("\\", "/")
  );
  return match?.[1] ?? "unknown";
}

const ADAPTER_REMEDIATION_AGENTS = {
  agents: "codex",
  claude: "claude-code",
  cursor: "cursor",
  codebuddy: "codebuddy"
} as const satisfies Record<string, HarnessAgent>;

export function adapterAgentForRemediation(
  remediationId: string | undefined
): HarnessAgent | null {
  const prefix = "refresh-managed-adapters-";
  if (remediationId === undefined || !remediationId.startsWith(prefix)) return null;
  const adapter = remediationId.slice(prefix.length);
  return ADAPTER_REMEDIATION_AGENTS[
    adapter as keyof typeof ADAPTER_REMEDIATION_AGENTS
  ] ?? null;
}

export function buildSyncRemediations(
  components: readonly ComponentReceipt[]
): SyncRemediation[] {
  const remediations: SyncRemediation[] = [];
  for (const component of components) {
    if (component.status === "OK") continue;
    const details = asRecord(component.details);
    if (component.component === "adapter-projection") {
      const conflicts = Array.isArray(details?.conflicts)
        ? details.conflicts.filter((item): item is Record<string, unknown> =>
            item !== null && typeof item === "object" && !Array.isArray(item)
          )
        : [];
      const grouped = new Map<string, Record<string, unknown>[]>();
      for (const conflict of conflicts) {
        const target = typeof conflict.target_path === "string"
          ? conflict.target_path
          : "unknown";
        const adapter = adapterName(target);
        grouped.set(adapter, [...(grouped.get(adapter) ?? []), conflict]);
      }
      for (const [adapter, adapterConflicts] of grouped) {
        remediations.push({
          id: `refresh-managed-adapters-${adapter}`,
          component: component.component,
          severity: "WARN",
          title: `${adapter} Adapter bundle drift (${adapterConflicts.length} files)`,
          autoFixable: adapter !== "unknown",
          risk: "medium",
          writes: adapter === "unknown"
            ? []
            : [
                `.${adapter}/**`,
                ".harness/rules/**",
                ".harness/context-index.json"
              ],
          backup: ".harness/state/transactions/<latest-committed-refresh>/before",
          rollback: "失败时自动回滚；其他情况可在继续编辑前恢复 refresh 事务的 before 快照",
          estimatedDurationMs: 3_000,
          requiresConfirmation: true,
          previewCommand:
            `npx hunter-harness sync --check --fix refresh-managed-adapters-${adapter} --json`,
          applyCommand: adapter === "unknown"
            ? ""
            : `npx hunter-harness sync --fix refresh-managed-adapters-${adapter} --yes --json`,
          affectedCount: adapterConflicts.length
        });
      }
      continue;
    }
    if (component.component === "knowledge") {
      remediations.push({
        id: "configure-remote-knowledge",
        component: component.component,
        severity: component.status === "FAIL"
          ? "FAIL"
          : component.status === "ADVISORY"
            ? "ADVISORY"
            : "WARN",
        title: "配置或恢复远端知识服务",
        autoFixable: false,
        risk: "low",
        writes: [],
        backup: null,
        rollback: null,
        estimatedDurationMs: null,
        requiresConfirmation: true,
        previewCommand: "npx hunter-harness knowledge query \"项目概览\" --json",
        applyCommand: ""
      });
      continue;
    }
    if (component.component === "rules" &&
        component.reasonCode === "INSTRUCTION_AUDIT_REQUIRED") {
      remediations.push({
        id: "audit-project-instructions",
        component: component.component,
        severity: "ADVISORY",
        title: "生成中文项目文档与规则优化提案",
        autoFixable: false,
        risk: "medium",
        writes: [".harness/state/local/instruction-proposals/**"],
        backup: null,
        rollback: null,
        estimatedDurationMs: null,
        requiresConfirmation: true,
        previewCommand: "npx hunter-harness instructions audit --json",
        applyCommand: "npx hunter-harness instructions apply --proposal <proposal.json> --yes --json"
      });
      continue;
    }
    remediations.push({
      id: `resolve-${component.component}`,
      component: component.component,
      severity: component.status === "FAIL"
        ? "FAIL"
        : component.status === "ADVISORY"
          ? "ADVISORY"
          : "WARN",
      title: `需要处理：${component.reasonCode}`,
      autoFixable: false,
      risk: "medium",
      writes: [],
      backup: null,
      rollback: null,
      estimatedDurationMs: null,
      requiresConfirmation: true,
      previewCommand: "npx hunter-harness sync --check --json",
      applyCommand: ""
    });
  }
  return remediations.sort((left, right) => left.id.localeCompare(right.id));
}

export function buildCompactSyncResult(input: {
  status: SyncStatus;
  runId: string;
  components: readonly ComponentReceipt[];
  remediations: readonly SyncRemediation[];
  versions: SyncVersions;
  verbose: boolean;
}): Record<string, unknown> {
  return {
    status: input.status,
    runId: input.runId,
    components: statusCounts(input.components),
    versions: input.versions,
    remediations: input.remediations,
    reportPath: null,
    reportSha256: null,
    ...(input.verbose
      ? {
          componentOutcomes: input.components,
          partialEffects: summarizePartialEffects(input.components)
        }
      : {})
  };
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function readSyncVersions(
  root: string,
  resourcesRoot: string,
  cliVersion: string
): Promise<SyncVersions> {
  const workflow = await readJsonRecord(join(resourcesRoot, "hunter-workflow-family.json"));
  const context = await readJsonRecord(join(root, ".harness", "context-index.json"));
  const bundles = asRecord(context?.skill_bundles);
  const adapterBundleVersions: Record<string, string> = {};
  for (const [adapter, raw] of Object.entries(bundles ?? {})) {
    const bundle = asRecord(raw);
    const version = bundle?.registry_version;
    if (typeof version === "string") adapterBundleVersions[adapter] = version;
  }
  return {
    cliVersion,
    workflowBundleVersion: typeof workflow?.bundle_version === "string"
      ? workflow.bundle_version
      : null,
    adapterBundleVersions
  };
}

function syncExitCode(status: SyncStatus): number {
  if (status === "OK" || status === "ADVISORY") return 0;
  if (status === "WARN") return 5;
  if (status === "BLOCKED") return 7;
  return 1;
}

function humanSyncSummary(payload: Record<string, unknown>): string {
  const counts = asRecord(payload.components) ?? {};
  const remediations = Array.isArray(payload.remediations)
    ? payload.remediations
    : [];
  return [
    `同步结果：${String(payload.status)}（` +
      `${String(counts.ok ?? 0)} OK, ` +
      `${String(counts.advisory ?? 0)} ADVISORY, ` +
      `${String(counts.warn ?? 0)} WARN, ` +
      `${String(counts.fail ?? 0)} FAIL）。`,
    `可选修复项：${remediations.length}。`,
    "本次同步不写运行报告，也不上报生命周期监控。"
  ].join("\n") + "\n";
}

function emitSyncResult(
  dependencies: CommandDependencies,
  options: SyncCommandOptions,
  payload: Record<string, unknown>
): void {
  dependencies.stdout(
    options.json === true
      ? JSON.stringify(payload) + "\n"
      : humanSyncSummary(payload)
  );
}

async function runPythonComponent(
  runtime: PythonRuntimeResolution,
  script: string,
  args: readonly string[],
  root: string,
  dependencies: CommandDependencies,
  progress: SyncCommandOptions["progress"],
  budget?: ProcessBudget
): Promise<ProcessResult> {
  return runProcess(
    [...runtime.argvPrefix, script, ...args],
    root,
    { ...dependencies.env, PYTHONDONTWRITEBYTECODE: "1" },
    progress === "none" ? () => undefined : dependencies.stderr,
    budget
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export async function probeCodeGraph(
  root: string,
  headCommit: string | null
): Promise<{
  status: SyncStatus;
  reasonCode: string;
  details: Record<string, unknown>;
}> {
  const directory = join(root, ".codegraph");
  try {
    if (!(await stat(directory)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    return {
      status: "WARN",
      reasonCode: "CODEGRAPH_NOT_INDEXED",
      details: {
        indexPresent: false,
        serviceReachable: null,
        indexedCommit: null,
        pendingFileCount: null,
        watcherLagMs: null,
        coverage: "NOT_INDEXED"
      }
    };
  }

  let metadata: Record<string, unknown> = {};
  for (const name of ["status.json", "metadata.json", "index.json"]) {
    try {
      const parsed = JSON.parse(
        await readFile(join(directory, name), "utf8")
      ) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        metadata = parsed as Record<string, unknown>;
        break;
      }
    } catch {
      // Probe the next supported metadata sidecar.
    }
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const indexFiles = entries
    .filter((entry) =>
      entry.isFile() && /\.(?:sqlite|sqlite3|db)$/i.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort();
  const fileStats = await Promise.all(
    indexFiles.map(async (name) => {
      const info = await stat(join(directory, name));
      return { name, size: info.size, modifiedAt: info.mtime.toISOString() };
    })
  );
  const indexedCommit = String(
    metadata.indexedCommit
    ?? metadata.indexedHead
    ?? metadata.headCommit
    ?? ""
  ) || null;
  const pendingRaw = metadata.pendingFileCount ?? metadata.pendingFiles;
  const pendingFileCount = typeof pendingRaw === "number"
    ? pendingRaw
    : Array.isArray(pendingRaw)
      ? pendingRaw.length
      : null;
  const watcherLagMs = typeof metadata.watcherLagMs === "number"
    ? metadata.watcherLagMs
    : null;
  const coverage = indexedCommit !== null && headCommit !== null
    ? indexedCommit === headCommit ? "CURRENT" : "STALE"
    : indexFiles.length > 0 ? "PRESENT_UNVERIFIED" : "EMPTY";
  const status: SyncStatus =
    coverage === "CURRENT" && (pendingFileCount ?? 0) === 0 ? "OK" : "WARN";
  const reasonCode = status === "OK"
    ? "OK"
    : coverage === "STALE"
      ? "CODEGRAPH_INDEX_STALE"
      : indexFiles.length === 0
        ? "CODEGRAPH_INDEX_EMPTY"
        : "CODEGRAPH_COVERAGE_UNVERIFIED";
  return {
    status,
    reasonCode,
    details: {
      indexPresent: true,
      serviceReachable: metadata.serviceReachable ?? null,
      indexedCommit,
      pendingFileCount,
      watcherLagMs,
      coverage,
      indexFiles: fileStats
    }
  };
}

export interface SyncWritePolicy {
  adapterReadOnly: boolean;
}

export function deriveSyncWritePolicy(
  options: Pick<SyncCommandOptions, "apply" | "fix">,
  checkMode: boolean
): SyncWritePolicy {
  if (checkMode) {
    return {
      adapterReadOnly: true
    };
  }
  if (options.fix?.startsWith("refresh-managed-adapters-") === true) {
    return {
      adapterReadOnly: false
    };
  }
  return {
    adapterReadOnly: false
  };
}

export async function runSync(
  options: SyncCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const root = resolve(options.project ?? dependencies.cwd);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const components: ComponentReceipt[] = [];
  const cliVersion = await readCliVersion();
  const versions = await readSyncVersions(root, dependencies.resourcesRoot, cliVersion);
  const checkMode = options.check === true || options.dryRun === true;
  const writePolicy = deriveSyncWritePolicy(options, checkMode);
  const verbose = options.verbose === true || options.includeComponents === true;
  const requestedApplyMode = (options as { apply?: unknown }).apply;
  if (requestedApplyMode !== undefined && requestedApplyMode !== "safe") {
    dependencies.stderr(`SYNC_APPLY_MODE_INVALID: ${String(requestedApplyMode)}\n`);
    return 3;
  }
  if (
    options.fix !== undefined &&
    adapterAgentForRemediation(options.fix) === null
  ) {
    dependencies.stderr(`SYNC_REMEDIATION_UNKNOWN: ${options.fix}\n`);
    return 3;
  }
  const workflowManifest = await readWorkflowFamilyManifest(dependencies.resourcesRoot);
  const compatibility = assessWorkflowCompatibility(workflowManifest, {
    cliVersion,
    capabilities: CLI_CAPABILITIES
  });
  components.push(receipt(
    "capabilities",
    Date.now(),
    compatibility.compatible ? "OK" : "BLOCKED",
    compatibility.reasonCode,
    {
    ...versions,
    capabilities: CLI_CAPABILITIES,
    compatibility
  }));
  if (!compatibility.compatible) {
    const compact = buildCompactSyncResult({
      status: "BLOCKED",
      runId,
      components,
      remediations: buildSyncRemediations(components),
      versions,
      verbose
    });
    emitSyncResult(dependencies, options, compact);
    return 7;
  }

  const runtimeStarted = Date.now();
  const runtime = await resolvePythonRuntime({
    projectRoot: root,
    env: dependencies.env
  });
  components.push(receipt(
    "runtime:python",
    runtimeStarted,
    runtime.available ? "OK" : "BLOCKED",
    runtime.available ? "OK" : "PYTHON_RUNTIME_UNAVAILABLE",
    runtime
  ));
  if (!runtime.available) {
    const remediations = buildSyncRemediations(components);
    const compact = buildCompactSyncResult({
      status: "BLOCKED" as const,
      runId,
      components,
      remediations,
      versions,
      verbose
    });
    emitSyncResult(dependencies, options, compact);
    return 7;
  }

  const detection = await detectProject(root);
  if (detection.status !== "valid") {
    components.push(receipt(
      "project",
      Date.now(),
      "BLOCKED",
      detection.status === "absent" ? "PROJECT_NOT_INITIALIZED" : "PROJECT_CONFIG_INVALID"
    ));
    const compact = buildCompactSyncResult({
      status: "BLOCKED" as const,
      runId,
      components,
      remediations: buildSyncRemediations(components),
      versions,
      verbose
    });
    emitSyncResult(dependencies, options, compact);
    return 7;
  }
  const agents = configuredAgents(detection.config.adapters.enabled);
  const selectedProfile = options.profile === undefined || options.profile === "interactive"
    ? detection.config.project.profiles[0] ?? "general"
    : options.profile;
  if (selectedProfile !== "general" && selectedProfile !== "java") {
    dependencies.stderr("SYNC_PROFILE_INVALID: profile must be interactive, general or java\n");
    return 3;
  }
  const surface = (
    detection.config.adapter_options?.codebuddy?.surface ?? "both"
  ) as CodeBuddySurface;
  const primaryAgent = agents[0] ?? "codex";
  const workflowBundleRoot = join(
    dependencies.resourcesRoot,
    "harness",
    "bundles",
    selectedProfile,
    primaryAgent
  );
  const adapterFixRequested = options.fix?.startsWith(
    "refresh-managed-adapters-"
  ) === true;
  const adapterFixAgent = adapterAgentForRemediation(options.fix);
  if (adapterFixRequested && !checkMode && options.yes !== true) {
    dependencies.stderr(
      "SYNC_REMEDIATION_CONFIRMATION_REQUIRED: adapter refresh requires --yes\n"
    );
    return 3;
  }
  if (adapterFixAgent !== null && !agents.includes(adapterFixAgent)) {
    dependencies.stderr(
      `SYNC_REMEDIATION_UNAVAILABLE: ${options.fix} is not enabled in this project\n`
    );
    return 3;
  }

  const gitStarted = Date.now();
  const gitDelta = await observeGitDelta(root);
  components.push(receipt(
    "git-delta",
    gitStarted,
    gitDelta.headCommit === null ? "UNKNOWN" : "OK",
    gitDelta.headCommit === null ? "GIT_HEAD_UNAVAILABLE" : "OK",
    gitDelta
  ));

  const refreshStarted = Date.now();
  try {
    const result = await refreshProject({
      projectRoot: root,
      resourcesRoot: dependencies.resourcesRoot,
      profile: selectedProfile,
      agents: adapterFixAgent === null ? agents : [adapterFixAgent],
      codebuddySurface: surface,
      dryRun: writePolicy.adapterReadOnly,
      forceManaged: adapterFixRequested && options.yes === true
    });
    const promotionCandidates = buildPromoteCandidates(result.conflicts);
    components.push(receipt(
      "adapter-projection",
      refreshStarted,
      result.conflicts.length === 0 ? "OK" : "WARN",
      result.conflicts.length === 0 ? "OK" : "ADAPTER_PROJECTION_CONFLICT",
      {
        applied: result.applied.length,
        removed: result.removed.length,
        preserved: result.preserved.length,
        conflicts: result.conflicts,
        promotionCandidates
      },
      result.conflicts.length === 0
        ? null
        : "检查源文件与 Adapter 的哈希及差异摘要。需要采纳的修改应先写入对应 `harness/` 真源，完成聚焦测试后再刷新；不要覆盖本地 Adapter 修改。",
      {
        persisted: writePolicy.adapterReadOnly
          ? []
          : [
              ...(result.applied.length > 0 ? [`Adapter 投影已应用 ${result.applied.length} 项变更`] : []),
              ...(result.removed.length > 0 ? [`Adapter 投影已移除 ${result.removed.length} 个可安全清理的目标`] : [])
            ],
        notPersisted: [
          ...(writePolicy.adapterReadOnly && result.applied.length > 0
            ? [`只读预览了 ${result.applied.length} 项 Adapter 投影变更`]
            : []),
          ...(writePolicy.adapterReadOnly && result.removed.length > 0
            ? [`只读预览了 ${result.removed.length} 个 Adapter 清理目标`]
            : []),
          ...(result.conflicts.length === 0
            ? []
            : [`已保留 ${result.conflicts.length} 个存在本地修改的 Adapter 目标`])
        ]
      }
    ));
  } catch (error) {
    components.push(receipt(
      "adapter-projection",
      refreshStarted,
      "FAIL",
      "ADAPTER_REFRESH_FAILED",
      String(error),
      undefined,
      { persisted: [], notPersisted: ["Adapter 投影未完成"] }
    ));
  }

  const knowledgeStarted = Date.now();
  components.push(receipt(
    "knowledge",
    knowledgeStarted,
    "OK",
    "KNOWLEDGE_REMOTE_OWNED",
    {
      ingest: "server-after-archive-upload",
      query: "remote-only",
      fallback: false,
      localIndex: false
    },
    null,
    {
      persisted: [],
      notPersisted: ["本地不生成或维护知识索引"]
    }
  ));

  const rulesStarted = Date.now();
  components.push(receipt(
    "rules",
    rulesStarted,
    "ADVISORY",
    "INSTRUCTION_AUDIT_REQUIRED",
    {
      workflow: ["远端审计", "生成中文提案", "人工确认后事务化应用"],
      inputs: ["项目类型", "现有文档", "Codebase Map", "近期变更总结"],
      localMutation: false,
      automaticRuleCandidateApplication: false,
      legacyMarkerInjection: false
    },
    "运行 `npx hunter-harness instructions audit --json` 生成提案；审阅后再使用 `npx hunter-harness instructions apply`。",
    {
      persisted: [],
      notPersisted: ["sync 不直接改写 AGENTS.md、Agent 文档或规则"]
    }
  ));

  const mapStarted = Date.now();
  const map = await assessCodebaseMapOnDisk(root);
  components.push(receipt(
    "codebase-map",
    mapStarted,
    map.status === "fresh" ? "OK" : "WARN",
    map.status === "fresh"
      ? "OK"
      : map.status === "missing"
        ? "CODEBASE_MAP_MISSING"
        : "CODEBASE_MAP_STALE",
    map
  ));

  const instructionStarted = Date.now();
  const instructions = await validateInstructionGraph(
    root,
    instructionEntrypointsForAgents(agents)
  );
  components.push(receipt(
    "instruction-graph",
    instructionStarted,
    instructions.status,
    instructions.entrypointIntegrity.reasonCodes[0] ?? (
      instructions.status === "OK" ? "OK" : "INSTRUCTION_TOPIC_MISSING"
    ),
    {
      entrypointIntegrity: instructions.entrypointIntegrity,
      guidanceReachability: {
        topics: instructions.effectiveGuidanceTopics,
        status: instructions.status
      },
      semanticQuality: "not-evaluated",
      reachableFileCount: instructions.reachableFiles.length,
      reachableFileSamples: instructions.reachableFiles.slice(0, 20),
      unresolvedReferenceCount: instructions.diagnostics.unresolvedCount,
      unresolvedReferenceSamples: instructions.unresolvedReferences,
      cycleCount: instructions.cycles.length,
      cycleSamples: instructions.cycles.slice(0, 10),
      edgeTypeCounts: instructions.diagnostics.edgeTypeCounts,
      diagnosticsPath: null
    }
  ));

  const configStarted = Date.now();
  const origins = await inspectConfigOrigins(root);
  const configDrift = origins.some((origin) => origin.drift);
  components.push(receipt(
    "config-origins",
    configStarted,
    configDrift ? "WARN" : "OK",
    configDrift ? "CONFIG_PROJECTION_DRIFT" : "OK",
    origins
  ));

  const changeStarted = Date.now();
  const changeScript = join(
    workflowBundleRoot,
    "scripts",
    "harness_change.py"
  );
  const changes = await runPythonComponent(
    runtime,
    changeScript,
    ["status", "--all", "--json"],
    root,
    dependencies,
    "none"
  );
  let changePayload: unknown = changes.stdout;
  try {
    changePayload = JSON.parse(changes.stdout);
  } catch {
    // Keep raw diagnostics when a legacy workflow script lacks status support.
  }
  components.push(receipt(
    "changes",
    changeStarted,
    changes.exitCode === 0 ? "OK" : "UNKNOWN",
    changes.exitCode === 0 ? "OK" : "CHANGE_STATUS_UNAVAILABLE",
    changePayload
  ));

  const codeGraphStarted = Date.now();
  const codeGraph = await assessCodeGraphStatus(root, {
    headCommit: gitDelta.headCommit
  });
  components.push(receipt(
    "codegraph",
    codeGraphStarted,
    codeGraph.status,
    codeGraph.reasonCode,
    codeGraph,
    codeGraph.status === "OK" ? null : codeGraph.action
  ));

  const status = overallStatus(components);
  const remediations = buildSyncRemediations(components);
  const compact = buildCompactSyncResult({
    status,
    runId,
    components,
    remediations,
    versions,
    verbose
  });
  emitSyncResult(dependencies, options, compact);
  return syncExitCode(status);
}
