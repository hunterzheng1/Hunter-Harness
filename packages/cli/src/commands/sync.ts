import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
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

type SyncStatus = "OK" | "WARN" | "FAIL" | "BLOCKED" | "UNKNOWN";

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

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function runProcess(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  onStderr: (value: string) => void,
  timeoutMs = 15 * 60 * 1000
): Promise<ProcessResult> {
  const executable = argv[0];
  if (executable === undefined) {
    return { exitCode: 1, stdout: "", stderr: "empty process argv" };
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
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 16 * 1024 * 1024) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4 * 1024 * 1024) stderr += chunk;
      onStderr(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveProcess({ exitCode: 1, stdout, stderr: stderr + error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveProcess({ exitCode: code ?? 1, stdout, stderr });
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
  origins: Awaited<ReturnType<typeof inspectConfigOrigins>>
): Promise<void> {
  const path = join(root, ".harness", "context-index.json");
  const existing = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await atomicWriteJson(path, {
    ...existing,
    canonicalConfigPaths: origins
      .filter((origin) => origin.canonicalExists)
      .map((origin) => origin.canonicalPath),
    generatedProjectionPaths: origins
      .filter((origin) => origin.projectionExists)
      .map((origin) => origin.projectionPath),
    sync: {
      status,
      observedAt: nowIso(),
      reportPath,
      reportSha256
    }
  });
}

async function runPythonComponent(
  runtime: PythonRuntimeResolution,
  script: string,
  args: readonly string[],
  root: string,
  dependencies: CommandDependencies,
  progress: SyncCommandOptions["progress"]
): Promise<ProcessResult> {
  return runProcess(
    [...runtime.argvPrefix, script, ...args],
    root,
    { ...dependencies.env, PYTHONDONTWRITEBYTECODE: "1" },
    progress === "none" ? () => undefined : dependencies.stderr
  );
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
    options.progress
  );
  let knowledgePayload: unknown = knowledge.stdout;
  try {
    knowledgePayload = JSON.parse(knowledge.stdout);
  } catch {
    // Preserve bounded raw diagnostics in the detailed report.
  }
  components.push(receipt(
    "knowledge",
    knowledgeStarted,
    knowledge.exitCode === 0 ? "OK" : "FAIL",
    knowledge.exitCode === 0 ? "OK" : "KNOWLEDGE_SYNC_FAILED",
    knowledgePayload
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
  components.push(receipt(
    "instruction-graph",
    instructionStarted,
    instructions.status,
    instructions.entrypointIntegrity.reasonCodes[0] ?? (
      instructions.status === "OK" ? "OK" : "INSTRUCTION_TOPIC_MISSING"
    ),
    instructions
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

  components.push(receipt(
    "codegraph",
    Date.now(),
    "UNKNOWN",
    "CODEGRAPH_COVERAGE_UNAVAILABLE",
    {
      serviceReachable: null,
      indexedCommit: null,
      pendingFileCount: null,
      watcherLagMs: null,
      coverage: "UNKNOWN",
      action: "No automatic full reindex was triggered."
    }
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
  await atomicWriteJson(reportAbsolute, report);
  const reportSha256 = (await sha256File(reportAbsolute)).slice(7);
  await updateContextIndexMetadata(root, reportRelative, reportSha256, status, origins);
  await atomicWriteJson(join(root, ".harness", "runtime", "sync", "last-success.json"), {
    schemaVersion: 1,
    runId,
    status,
    completedAt: nowIso(),
    reportPath: reportRelative,
    reportSha256,
    headCommit: gitDelta.headCommit
  });
  dependencies.stdout(JSON.stringify({
    status,
    runId,
    components: statusCounts(components),
    reportPath: reportRelative,
    reportSha256
  }) + "\n");
  return status === "OK" ? 0 : status === "WARN" ? 5 : status === "BLOCKED" ? 7 : 1;
}
