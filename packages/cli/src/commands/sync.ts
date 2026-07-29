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
import { observeGitDelta } from "../sync/git-delta.js";
import { CLI_CAPABILITIES } from "../workflow-data/compatibility.js";
import { readCliVersion } from "../version.js";

export interface SyncCommandOptions {
  project?: string;
  profile?: string;
  json?: boolean;
  dryRun?: boolean;
  progress?: "jsonl" | "text" | "none";
}

export type SyncStatus = "OK" | "WARN" | "FAIL" | "BLOCKED" | "UNKNOWN";

interface ComponentReceipt {
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
  details?: unknown;
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
  details?: unknown
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
    nextAction: null,
    ...(details === undefined ? {} : { details })
  };
}

function overallStatus(components: readonly ComponentReceipt[]): SyncStatus {
  if (components.some((item) => item.status === "BLOCKED")) return "BLOCKED";
  if (components.some((item) => item.status === "FAIL")) return "FAIL";
  if (components.some((item) => item.status === "WARN")) return "WARN";
  if (components.some((item) => item.status === "UNKNOWN")) return "WARN";
  return "OK";
}

function statusCounts(components: readonly ComponentReceipt[]): Record<string, number> {
  return Object.fromEntries(
    (["OK", "WARN", "FAIL", "BLOCKED", "UNKNOWN"] as const).map((status) => [
      status.toLowerCase(),
      components.filter((item) => item.status === status).length
    ])
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

export function classifyKnowledgeResult(
  result: ProcessResult,
  outputValid: boolean
): { status: SyncStatus; reasonCode: string } {
  if (result.exitCode === 0 && !result.timedOut) {
    return { status: "OK", reasonCode: "OK" };
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

export async function runSync(
  options: SyncCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const root = resolve(options.project ?? dependencies.cwd);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const components: ComponentReceipt[] = [];
  const runStartedAt = nowIso();
  const cliVersion = await readCliVersion();
  components.push(receipt("capabilities", Date.now(), "OK", "OK", {
    cliVersion,
    capabilities: CLI_CAPABILITIES
  }));

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
    const compact = {
      status: "BLOCKED",
      runId,
      components: statusCounts(components),
      reportPath: null,
      reportSha256: null
    };
    dependencies.stdout(JSON.stringify(compact) + "\n");
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
    dependencies.stdout(JSON.stringify({
      status: "BLOCKED",
      runId,
      components: statusCounts(components),
      reportPath: null,
      reportSha256: null
    }) + "\n");
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
      agents,
      codebuddySurface: surface,
      dryRun: options.dryRun === true,
      forceManaged: false
    });
    components.push(receipt(
      "adapter-projection",
      refreshStarted,
      result.conflicts.length === 0 ? "OK" : "WARN",
      result.conflicts.length === 0 ? "OK" : "ADAPTER_PROJECTION_CONFLICT",
      {
        applied: result.applied.length,
        removed: result.removed.length,
        preserved: result.preserved.length,
        conflicts: result.conflicts.slice(0, 5)
      }
    ));
  } catch (error) {
    components.push(receipt(
      "adapter-projection",
      refreshStarted,
      "FAIL",
      "ADAPTER_REFRESH_FAILED",
      String(error)
    ));
  }

  const knowledgeStarted = Date.now();
  const knowledgeScript = join(
    workflowBundleRoot,
    "harness-knowledge-ingest",
    "scripts",
    "harness_knowledge.py"
  );
  const knowledge = await runPythonComponent(
    runtime,
    knowledgeScript,
    [
      "sync",
      "--project",
      root,
      ...(options.dryRun === true ? [] : ["--update"]),
      "--json",
      "--progress",
      options.progress ?? "jsonl"
    ],
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
  const knowledgeOutputValid = parsedKnowledgePayload?.ok === true;
  const knowledgeOutcome = classifyKnowledgeResult(
    knowledge,
    knowledgeOutputValid
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
    }
  ));

  const rulesStarted = Date.now();
  try {
    if (options.dryRun !== true) {
      const projections = await synchronizeProjectRules(root, agents, surface);
      const candidates = await synchronizeRuleCandidates(root);
      components.push(receipt(
        "rules",
        rulesStarted,
        projections.conflicts.length === 0 ? "OK" : "WARN",
        projections.conflicts.length === 0 ? "OK" : "RULE_PROJECTION_CONFLICT",
        {
          applied: projections.written.length,
          conflicts: projections.conflicts.slice(0, 5),
          pendingReview: candidates.candidates
        }
      ));
    } else {
      components.push(receipt("rules", rulesStarted, "UNKNOWN", "DRY_RUN_NOT_EXECUTED"));
    }
  } catch (error) {
    components.push(receipt("rules", rulesStarted, "FAIL", "RULE_SYNC_FAILED", String(error)));
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
      effectiveGuidanceTopics: instructions.effectiveGuidanceTopics,
      reachableFileCount: instructions.reachableFiles.length,
      reachableFileSamples: instructions.reachableFiles.slice(0, 20),
      unresolvedReferenceCount: instructions.diagnostics.unresolvedCount,
      unresolvedReferenceSamples: instructions.unresolvedReferences,
      cycleCount: instructions.cycles.length,
      cycleSamples: instructions.cycles.slice(0, 10),
      edgeTypeCounts: instructions.diagnostics.edgeTypeCounts,
      diagnosticsPath: options.dryRun === true
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

  const codegraphStarted = Date.now();
  const codegraph = await probeCodeGraph(root, gitDelta.headCommit);
  components.push(receipt(
    "codegraph",
    codegraphStarted,
    codegraph.status,
    codegraph.reasonCode,
    codegraph.details
  ));

  const status = overallStatus(components);
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
    components
  };
  if (options.dryRun === true) {
    dependencies.stdout(JSON.stringify({
      status,
      runId,
      components: statusCounts(components),
      reportPath: null,
      reportSha256: null
    }) + "\n");
    return status === "OK" ? 0 : status === "WARN" ? 5 : status === "BLOCKED" ? 7 : 1;
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
  const successful = status === "OK" || status === "WARN";
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
  dependencies.stdout(JSON.stringify({
    status,
    runId,
    components: statusCounts(components),
    reportPath: reportRelative,
    reportSha256
  }) + "\n");
  return status === "OK" ? 0 : status === "WARN" ? 5 : status === "BLOCKED" ? 7 : 1;
}
