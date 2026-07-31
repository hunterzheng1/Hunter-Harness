import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  assessCodebaseMapOnDisk,
  atomicWriteJson,
  refreshProject,
  sha256File,
  synchronizeProjectRules,
  synchronizeRuleCandidates,
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

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  lastActivityAt: string;
  timedOut: boolean;
  timeoutKind: "wall" | "stall" | null;
  termination: "exited" | "spawn-error" | "terminated" | "killed";
  signal: NodeJS.Signals | null;
  heartbeatCount: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface ProcessBudget {
  wallTimeoutMs: number;
  stallTimeoutMs?: number;
  heartbeatMs?: number;
  terminateGraceMs?: number;
}

export interface SyncPointer {
  schemaVersion: 1;
  runId: string;
  status: SyncStatus;
  completedAt: string;
  reportPath: string;
  reportSha256: string;
  headCommit: string | null;
}

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
  const budget: ProcessBudget = typeof budgetInput === "number"
    ? { wallTimeoutMs: budgetInput }
    : budgetInput;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const executable = argv[0];
  if (executable === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "empty process argv",
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      lastActivityAt: startedAt,
      timedOut: false,
      timeoutKind: null,
      termination: "spawn-error",
      signal: null,
      heartbeatCount: 0,
      stdoutTruncated: false,
      stderrTruncated: false
    };
  }
  return new Promise((resolveProcess) => {
    const child = spawn(executable, argv.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let lastActivityMs = startedAtMs;
    let activityObserved = false;
    let timedOut = false;
    let timeoutKind: ProcessResult["timeoutKind"] = null;
    let hardKillRequested = false;
    let settled = false;
    let heartbeatCount = 0;
    const heartbeatMs = Math.max(10, budget.heartbeatMs ?? 30_000);
    const stallTimeoutMs = budget.stallTimeoutMs;
    const terminateGraceMs = Math.max(10, budget.terminateGraceMs ?? 2_000);
    let killTimer: NodeJS.Timeout | undefined;

    const stopTimers = (): void => {
      clearTimeout(wallTimer);
      clearInterval(heartbeatTimer);
      if (stallTimer !== undefined) clearInterval(stallTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const terminate = (kind: "wall" | "stall"): void => {
      if (timedOut || settled) return;
      timedOut = true;
      timeoutKind = kind;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (settled) return;
        hardKillRequested = true;
        child.kill("SIGKILL");
      }, terminateGraceMs);
    };
    const wallTimer = setTimeout(
      () => terminate("wall"),
      Math.max(1, budget.wallTimeoutMs)
    );
    const heartbeatTimer = setInterval(() => {
      heartbeatCount += 1;
      onStderr(JSON.stringify({
        type: "process.heartbeat",
        elapsedMs: Date.now() - startedAtMs,
        idleMs: Date.now() - lastActivityMs
      }) + "\n");
    }, heartbeatMs);
    const stallTimer = stallTimeoutMs === undefined
      ? undefined
      : setInterval(() => {
          if (Date.now() - lastActivityMs >= stallTimeoutMs) terminate("stall");
        }, Math.max(10, Math.min(heartbeatMs, Math.floor(stallTimeoutMs / 2))));

    const finish = (
      exitCode: number,
      termination: ProcessResult["termination"],
      signal: NodeJS.Signals | null
    ): void => {
      if (settled) return;
      settled = true;
      stopTimers();
      const completedAtMs = Date.now();
      const reportedActivityMs = activityObserved
        ? Math.max(lastActivityMs, startedAtMs + 1)
        : lastActivityMs;
      resolveProcess({
        exitCode,
        stdout,
        stderr,
        startedAt,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
        lastActivityAt: new Date(reportedActivityMs).toISOString(),
        timedOut,
        timeoutKind,
        termination,
        signal,
        heartbeatCount,
        stdoutTruncated,
        stderrTruncated
      });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      activityObserved = true;
      lastActivityMs = Date.now();
      if (stdout.length < 16 * 1024 * 1024) {
        stdout += chunk.slice(0, 16 * 1024 * 1024 - stdout.length);
      }
      if (stdout.length >= 16 * 1024 * 1024) stdoutTruncated = true;
    });
    child.stderr.on("data", (chunk: string) => {
      activityObserved = true;
      lastActivityMs = Date.now();
      if (stderr.length < 4 * 1024 * 1024) {
        stderr += chunk.slice(0, 4 * 1024 * 1024 - stderr.length);
      }
      if (stderr.length >= 4 * 1024 * 1024) stderrTruncated = true;
      onStderr(chunk);
    });
    child.on("error", (error) => {
      stderr += error.message;
      finish(1, "spawn-error", null);
    });
    child.on("close", (code, signal) => {
      finish(
        code ?? (timedOut ? 124 : 1),
        timedOut ? (hardKillRequested ? "killed" : "terminated") : "exited",
        signal
      );
    });
  });
}

function configuredAgents(values: readonly string[]): HarnessAgent[] {
  const enabled = new Set(values);
  return HARNESS_AGENT_ORDER.filter((agent) => enabled.has(agent));
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
    return "Review the preserved adapter change, apply the intended update to the `harness/` source of truth, run its focused tests, then refresh adapters; do not overwrite the local adapter file.";
  }
  if (component === "runtime:python") {
    return "Install or select a usable Python runtime, then re-run `hunter-harness sync`.";
  }
  if (reasonCode === "DRY_RUN_NOT_EXECUTED") {
    return "Run `hunter-harness sync` without `--dry-run` after reviewing this preview.";
  }
  return `Resolve ${reasonCode} for ${component}, then re-run \`hunter-harness sync\` and inspect its component receipt.`;
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
      ? "No durable sync effects were recorded before the overall result."
      : `Durable effects already persisted: ${persisted.join("; ")}.${notPersisted.length === 0 ? "" : ` Not persisted: ${notPersisted.join("; ")}.`}`
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
                ".harness/runtime/sync/**",
                ".harness/context-index.json"
              ],
          backup: ".harness/state/transactions/<latest-committed-refresh>/before",
          rollback: "automatic-on-failure; otherwise restore the committed refresh before snapshot before further edits",
          estimatedDurationMs: 3_000,
          requiresConfirmation: true,
          previewCommand:
            `hunter-harness sync --check --fix refresh-managed-adapters-${adapter} --json`,
          applyCommand: adapter === "unknown"
            ? ""
            : `hunter-harness sync --fix refresh-managed-adapters-${adapter} --yes --json`,
          affectedCount: adapterConflicts.length
        });
      }
      continue;
    }
    if (component.component === "knowledge") {
      remediations.push({
        id: "knowledge-maintain",
        component: component.component,
        severity: component.status === "FAIL"
          ? "FAIL"
          : component.status === "ADVISORY"
            ? "ADVISORY"
            : "WARN",
        title: "Repair and maintain the project knowledge index",
        autoFixable: component.status !== "FAIL",
        risk: "low",
        writes: [
          ".harness/knowledge/**",
          ".harness/runtime/sync/**",
          ".harness/context-index.json"
        ],
        backup: null,
        rollback: null,
        estimatedDurationMs: null,
        requiresConfirmation: false,
        previewCommand: "hunter-harness sync --check --json",
        applyCommand: "hunter-harness sync --apply safe --json"
      });
      continue;
    }
    if (component.component === "rules" &&
        component.reasonCode === "RULE_REVIEW_PENDING") {
      remediations.push({
        id: "review-rule-candidates",
        component: component.component,
        severity: "ADVISORY",
        title: "Review pending rule candidates",
        autoFixable: false,
        risk: "medium",
        writes: [".harness/rules/**"],
        backup: null,
        rollback: null,
        estimatedDurationMs: null,
        requiresConfirmation: true,
        previewCommand: "hunter-harness rules-review --json",
        applyCommand: "hunter-harness rules-review --apply <decisions.json> --json"
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
      title: `Resolve ${component.reasonCode}`,
      autoFixable: false,
      risk: "medium",
      writes: [],
      backup: null,
      rollback: null,
      estimatedDurationMs: null,
      requiresConfirmation: true,
      previewCommand: "hunter-harness sync --check --json",
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
  reportPath: string | null;
  reportSha256: string | null;
  verbose: boolean;
}): Record<string, unknown> {
  return {
    status: input.status,
    runId: input.runId,
    components: statusCounts(input.components),
    versions: input.versions,
    remediations: input.remediations,
    reportPath: input.reportPath,
    reportSha256: input.reportSha256,
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
  const reportPath = typeof payload.reportPath === "string"
    ? payload.reportPath
    : "read-only check (no report written)";
  return [
    `Sync ${String(payload.status)}: ` +
      `${String(counts.ok ?? 0)} OK, ` +
      `${String(counts.advisory ?? 0)} advisory, ` +
      `${String(counts.warn ?? 0)} WARN, ` +
      `${String(counts.fail ?? 0)} FAIL.`,
    `Remediations: ${remediations.length}.`,
    `Report: ${reportPath}`
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

async function updateContextIndexMetadata(
  root: string,
  reportPath: string,
  reportSha256: string,
  status: SyncStatus,
  origins: Awaited<ReturnType<typeof inspectConfigOrigins>>,
  pointer: SyncPointer,
  successful: boolean
): Promise<void> {
  const path = join(root, ".harness", "context-index.json");
  const existing = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const previousSync = existing.sync;
  const sync = previousSync !== null && typeof previousSync === "object"
    ? previousSync as Record<string, unknown>
    : {};
  await atomicWriteJson(path, {
    ...existing,
    canonicalConfigPaths: origins
      .filter((origin) => origin.canonicalExists)
      .map((origin) => origin.canonicalPath),
    generatedProjectionPaths: origins
      .filter((origin) => origin.projectionExists)
      .map((origin) => origin.projectionPath),
    sync: {
      ...sync,
      status,
      observedAt: nowIso(),
      reportPath,
      reportSha256,
      lastRun: pointer,
      ...(successful ? { lastSuccess: pointer } : {})
    }
  });
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

function positiveEnvMs(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: number
): number {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `sync_status()` reports `ok` only once the index is current AND the
 * maintenance outbox (drain_maintenance_outbox) has been fully drained.
 * Older/degraded payloads may omit `maintenance` entirely -- treat that as
 * valid so this stays backward compatible with pre-HH-KNOW-20260730-001
 * workflow bundles.
 */
export function deriveKnowledgeOutputValid(
  payload: Record<string, unknown> | null | undefined
): boolean {
  if (payload === null || payload === undefined) return false;
  if (payload.ok === true) return true;
  if (payload.upToDate !== true) return false;
  const maintenance = asRecord(payload.maintenance);
  if (maintenance === null) return true;
  if (maintenance.skipped === true) return true;
  return maintenance.ok !== false;
}

function isKnowledgeOutboxPending(
  payload: Record<string, unknown> | null | undefined
): boolean {
  if (payload === null || payload === undefined) return false;
  if (payload.upToDate !== true) return false;
  const maintenance = asRecord(payload.maintenance);
  if (maintenance === null || maintenance.skipped === true) return false;
  return maintenance.ok === false;
}

export function classifyKnowledgeResult(
  result: ProcessResult,
  outputValid: boolean,
  payload?: Record<string, unknown> | null
): { status: SyncStatus; reasonCode: string } {
  if (result.exitCode === 0 && !result.timedOut) {
    if (outputValid) {
      const health = asRecord(payload?.health);
      if (health?.status === "WARN") {
        return { status: "WARN", reasonCode: "KNOWLEDGE_HEALTH_WARN" };
      }
      if (health?.status === "ADVISORY") {
        return { status: "ADVISORY", reasonCode: "KNOWLEDGE_HEALTH_ADVISORY" };
      }
      return { status: "OK", reasonCode: "OK" };
    }
    if (isKnowledgeOutboxPending(payload)) {
      return { status: "WARN", reasonCode: "KNOWLEDGE_OUTBOX_PENDING" };
    }
    return { status: "WARN", reasonCode: "KNOWLEDGE_OUTPUT_UNVERIFIED" };
  }
  if (result.timedOut && outputValid) {
    return {
      status: "WARN",
      reasonCode: "KNOWLEDGE_SYNC_TIMEOUT_OUTPUT_VALID"
    };
  }
  if (result.timeoutKind === "stall") {
    return { status: "FAIL", reasonCode: "KNOWLEDGE_SYNC_STALL_TIMEOUT" };
  }
  if (result.timeoutKind === "wall") {
    return { status: "FAIL", reasonCode: "KNOWLEDGE_SYNC_WALL_TIMEOUT" };
  }
  if (result.termination === "spawn-error") {
    return { status: "FAIL", reasonCode: "KNOWLEDGE_SYNC_SPAWN_FAILED" };
  }
  return { status: "FAIL", reasonCode: "KNOWLEDGE_SYNC_FAILED" };
}

/** Ensures WARN/FAIL knowledge receipts always carry an actionable next step. */
export function resolveKnowledgeNextAction(
  status: SyncStatus,
  reasonCode: string,
  payload?: Record<string, unknown> | null
): string | null {
  if (status === "OK") return null;
  const payloadNextAction = payload?.nextAction;
  if (typeof payloadNextAction === "string" && payloadNextAction.length > 0) {
    return payloadNextAction;
  }
  switch (reasonCode) {
    case "KNOWLEDGE_HEALTH_WARN":
      return "Run `hunter-harness sync --apply safe --json` to apply deterministic knowledge repairs, then inspect the freshness and health summaries.";
    case "KNOWLEDGE_HEALTH_ADVISORY":
      return "Inspect the knowledge health dimensions; no freshness failure blocks this sync.";
    case "KNOWLEDGE_OUTBOX_PENDING":
      return (
        "Retry `hunter-harness sync`, or run `python harness/harness-knowledge-ingest/" +
        "scripts/harness_knowledge.py maintain --project <project> --drain` to drain " +
        "the remaining maintenance outbox items."
      );
    case "KNOWLEDGE_SYNC_TIMEOUT_OUTPUT_VALID":
      return "Re-run `hunter-harness sync`; the knowledge sync process timed out but returned a valid result.";
    case "KNOWLEDGE_SYNC_STALL_TIMEOUT":
    case "KNOWLEDGE_SYNC_WALL_TIMEOUT":
      return (
        "Re-run `hunter-harness sync`; raise HUNTER_HARNESS_SYNC_KNOWLEDGE_WALL_TIMEOUT_MS " +
        "or HUNTER_HARNESS_SYNC_KNOWLEDGE_STALL_TIMEOUT_MS if it keeps timing out."
      );
    case "KNOWLEDGE_SYNC_SPAWN_FAILED":
      return "Verify the Python runtime is available, then re-run `hunter-harness sync`.";
    default:
      return "Retry `hunter-harness sync` to reconcile the knowledge index and maintenance outbox.";
  }
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

export async function persistSyncPointers(
  root: string,
  pointer: SyncPointer,
  successful: boolean
): Promise<void> {
  const directory = join(root, ".harness", "runtime", "sync");
  await mkdir(directory, { recursive: true });
  await atomicWriteJson(join(directory, "last-run.json"), pointer);
  if (successful) {
    await atomicWriteJson(join(directory, "last-success.json"), pointer);
  }
}

export function shouldApplyKnowledgeMaintenance(
  options: Pick<SyncCommandOptions, "apply" | "fix">,
  checkMode: boolean
): boolean {
  return !checkMode &&
    (options.apply === "safe" || options.fix === "knowledge-maintain");
}

export interface SyncWritePolicy {
  adapterReadOnly: boolean;
  knowledgeMode: "check" | "update" | "auto";
  rulesReadOnly: boolean;
}

export function deriveSyncWritePolicy(
  options: Pick<SyncCommandOptions, "apply" | "fix">,
  checkMode: boolean
): SyncWritePolicy {
  if (checkMode) {
    return {
      adapterReadOnly: true,
      knowledgeMode: "check",
      rulesReadOnly: true
    };
  }
  if (options.fix?.startsWith("refresh-managed-adapters-") === true) {
    return {
      adapterReadOnly: false,
      knowledgeMode: "check",
      rulesReadOnly: true
    };
  }
  if (shouldApplyKnowledgeMaintenance(options, checkMode)) {
    return {
      adapterReadOnly: true,
      knowledgeMode: "auto",
      rulesReadOnly: true
    };
  }
  return {
    adapterReadOnly: false,
    knowledgeMode: "update",
    rulesReadOnly: false
  };
}

export async function runSync(
  options: SyncCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const root = resolve(options.project ?? dependencies.cwd);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const components: ComponentReceipt[] = [];
  const runStartedAt = nowIso();
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
    options.fix !== "knowledge-maintain" &&
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
      reportPath: null,
      reportSha256: null,
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
      reportPath: null,
      reportSha256: null,
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
      reportPath: null,
      reportSha256: null,
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
        : "Review the source/adapter hashes and diff summaries in this receipt. For each intended patch, modify the matching `harness/` source of truth, run focused tests, then refresh adapters; do not overwrite local adapter edits.",
      {
        persisted: writePolicy.adapterReadOnly
          ? []
          : [
              ...(result.applied.length > 0 ? [`adapter projection applied ${result.applied.length} change(s)`] : []),
              ...(result.removed.length > 0 ? [`adapter projection removed ${result.removed.length} clean target(s)`] : [])
            ],
        notPersisted: [
          ...(writePolicy.adapterReadOnly && result.applied.length > 0
            ? [`adapter projection previewed ${result.applied.length} change(s)`]
            : []),
          ...(writePolicy.adapterReadOnly && result.removed.length > 0
            ? [`adapter projection previewed removal of ${result.removed.length} clean target(s)`]
            : []),
          ...(result.conflicts.length === 0
            ? []
            : [`${result.conflicts.length} locally modified adapter target(s) were preserved`])
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
      { persisted: [], notPersisted: ["adapter projection did not complete"] }
    ));
  }

  const knowledgeStarted = Date.now();
  const knowledgeScript = join(
    workflowBundleRoot,
    "harness-knowledge-ingest",
    "scripts",
    "harness_knowledge.py"
  );
  const knowledgeArgs = writePolicy.knowledgeMode === "auto"
    ? [
        "auto",
        "--project",
        root
      ]
    : [
        "sync",
        "--project",
        root,
        ...(writePolicy.knowledgeMode === "check" ? ["--check"] : ["--update"]),
        "--json",
        "--progress",
        options.progress ?? "jsonl"
      ];
  const knowledge = await runPythonComponent(
    runtime,
    knowledgeScript,
    knowledgeArgs,
    root,
    dependencies,
    options.progress,
    {
      wallTimeoutMs: positiveEnvMs(
        dependencies.env,
        "HUNTER_HARNESS_SYNC_KNOWLEDGE_WALL_TIMEOUT_MS",
        15 * 60 * 1000
      ),
      stallTimeoutMs: positiveEnvMs(
        dependencies.env,
        "HUNTER_HARNESS_SYNC_KNOWLEDGE_STALL_TIMEOUT_MS",
        3 * 60 * 1000
      ),
      heartbeatMs: positiveEnvMs(
        dependencies.env,
        "HUNTER_HARNESS_SYNC_HEARTBEAT_MS",
        30_000
      ),
      terminateGraceMs: positiveEnvMs(
        dependencies.env,
        "HUNTER_HARNESS_SYNC_TERMINATE_GRACE_MS",
        2_000
      )
    }
  );
  let knowledgePayload: unknown = knowledge.stdout;
  let parsedKnowledgePayload: Record<string, unknown> | null = null;
  try {
    knowledgePayload = JSON.parse(knowledge.stdout);
    if (knowledgePayload !== null && typeof knowledgePayload === "object") {
      parsedKnowledgePayload = knowledgePayload as Record<string, unknown>;
    }
  } catch {
    // Preserve bounded raw diagnostics in the detailed report.
  }
  const knowledgeOutputValid = deriveKnowledgeOutputValid(parsedKnowledgePayload);
  const knowledgeOutcome = classifyKnowledgeResult(
    knowledge,
    knowledgeOutputValid,
    parsedKnowledgePayload
  );
  const knowledgeNextAction = resolveKnowledgeNextAction(
    knowledgeOutcome.status,
    knowledgeOutcome.reasonCode,
    parsedKnowledgePayload
  );
  components.push(receipt(
    "knowledge",
    knowledgeStarted,
    knowledgeOutcome.status,
    knowledgeOutcome.reasonCode,
    {
      payload: knowledgePayload,
      postValidation: {
        valid: knowledgeOutputValid,
        reasonCode: knowledgeOutputValid
          ? "KNOWLEDGE_OUTPUT_VALID"
          : "KNOWLEDGE_OUTPUT_UNVERIFIED"
      },
      process: knowledge
    },
    knowledgeNextAction,
    {
      persisted: knowledgeOutputValid && writePolicy.knowledgeMode !== "check"
        ? ["knowledge sync returned verified output"]
        : [],
      notPersisted: knowledgeOutputValid || writePolicy.knowledgeMode === "check"
        ? []
        : ["knowledge output was not verified"]
    }
  ));

  const rulesStarted = Date.now();
  try {
    const projections = await synchronizeProjectRules(
      root,
      agents,
      surface,
      { dryRun: writePolicy.rulesReadOnly }
    );
    const candidates = await synchronizeRuleCandidates(
      root,
      { dryRun: writePolicy.rulesReadOnly }
    );
    const rulesStatus: SyncStatus = projections.conflicts.length > 0
      ? "WARN"
      : candidates.candidates > 0
        ? "ADVISORY"
        : "OK";
    const rulesReason = projections.conflicts.length > 0
      ? "RULE_PROJECTION_CONFLICT"
      : candidates.candidates > 0
        ? "RULE_REVIEW_PENDING"
        : "OK";
    components.push(receipt(
      "rules",
      rulesStarted,
      rulesStatus,
      rulesReason,
      {
        projected: projections.written.length,
        preview: writePolicy.rulesReadOnly,
        conflicts: projections.conflicts,
        pendingReview: candidates.candidates,
        guidanceReachability: "evaluated",
        semanticQuality: "not-evaluated"
      },
      undefined,
      {
        persisted: !writePolicy.rulesReadOnly && projections.written.length > 0
          ? [`rule projection wrote ${projections.written.length} file(s)`]
          : [],
        notPersisted: [
          ...(writePolicy.rulesReadOnly && projections.written.length > 0
            ? [`rule projection previewed ${projections.written.length} file(s)`]
            : []),
          ...(projections.conflicts.length > 0
            ? [`${projections.conflicts.length} rule projection conflict(s) need review`]
            : [])
        ]
      }
    ));
  } catch (error) {
    components.push(receipt(
      "rules",
      rulesStarted,
      "FAIL",
      "RULE_SYNC_FAILED",
      String(error),
      undefined,
      { persisted: [], notPersisted: ["rule synchronization did not complete"] }
    ));
  }

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
  const instructions = await validateInstructionGraph(root);
  const instructionDiagnosticsRelative =
    `.harness/runtime/sync/${runId}/instruction-graph-diagnostics.json`;
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
      diagnosticsPath: checkMode
        ? null
        : instructionDiagnosticsRelative
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
    codeGraph
  ));

  const status = overallStatus(components);
  const partialEffects = summarizePartialEffects(components);
  const remediations = buildSyncRemediations(components);
  const reportRelative = `.harness/runtime/sync/${runId}/reports/sync-report.json`;
  const reportAbsolute = join(root, reportRelative);
  const report = {
    schemaVersion: 1,
    runId,
    runStartedAt,
    completedAt: nowIso(),
    status,
    projectRoot: root,
    headCommit: gitDelta.headCommit,
    versions,
    components,
    partialEffects,
    remediations
  };
  if (checkMode) {
    const compact = buildCompactSyncResult({
      status,
      runId,
      components,
      remediations,
      versions,
      reportPath: null,
      reportSha256: null,
      verbose
    });
    emitSyncResult(dependencies, options, compact);
    return syncExitCode(status);
  }
  await mkdir(join(root, `.harness/runtime/sync/${runId}/reports`), { recursive: true });
  await atomicWriteJson(
    join(root, instructionDiagnosticsRelative),
    instructions
  );
  await atomicWriteJson(reportAbsolute, report);
  const reportSha256 = (await sha256File(reportAbsolute)).slice(7);
  const pointer: SyncPointer = {
    schemaVersion: 1,
    runId,
    status,
    completedAt: nowIso(),
    reportPath: reportRelative,
    reportSha256,
    headCommit: gitDelta.headCommit
  };
  const successful =
    status === "OK" || status === "ADVISORY" || status === "WARN";
  await persistSyncPointers(root, pointer, successful);
  await updateContextIndexMetadata(
    root,
    reportRelative,
    reportSha256,
    status,
    origins,
    pointer,
    successful
  );
  const compact = buildCompactSyncResult({
    status,
    runId,
    components,
    remediations,
    versions,
    reportPath: reportRelative,
    reportSha256,
    verbose
  });
  emitSyncResult(dependencies, options, compact);
  return syncExitCode(status);
}
