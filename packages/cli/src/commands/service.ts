import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  runPythonJson,
  type ManagedProcessBudget,
  type PythonRuntimeResolution
} from "@hunter-harness/core";
import { MANAGED_EXECUTION_EXIT_CODE_BY_REASON } from "@hunter-harness/contracts";

import type { CommandDependencies } from "./configure.js";

export type ServiceAction = "ensure" | "status" | "stop" | "retire-stale" | "link-superseder";

export interface ServiceCommandOptions {
  changeDir: string;
  project?: string;
  files?: string;
  changeName?: string;
  overlay?: string;
  leasedPort?: number;
  leaseOwner?: string;
  worktreeRoot?: string;
  executionRoot?: string;
  attemptId?: string;
  ifStartedByAi?: boolean;
  retirementReceipt?: string;
  json?: boolean;
}

export interface ServiceCommandContext {
  runtime?: PythonRuntimeResolution;
  script?: string;
}

const SERVICE_BUDGET: ManagedProcessBudget = {
  wallTimeoutMs: 120_000,
  stallTimeoutMs: 45_000,
  heartbeatMs: 10_000,
  terminateGraceMs: 2_000
};

async function findServiceScript(
  dependencies: CommandDependencies,
  name: string
): Promise<string> {
  const candidates = [
    join(dependencies.resourcesRoot, "harness", "bundles", "general", "codex", "scripts", name),
    join(dependencies.resourcesRoot, "harness", "bundles", "general", "claude-code", "scripts", name),
    join(dependencies.resourcesRoot, "scripts", name),
    join(dependencies.cwd, "harness", "scripts", name),
    join(dependencies.cwd, name)
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return resolve(candidate);
    } catch {
      // Deterministic fallback list; a missing script is reported by the
      // typed child transport rather than guessed or shell-expanded.
    }
  }
  return resolve(candidates[0] ?? join(dependencies.cwd, name));
}

function reasonCodeOf(payload: unknown, fallback: string): string {
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["reasonCode", "code"]) {
      if (typeof record[key] === "string" && record[key]) return record[key];
    }
  }
  return fallback;
}

function exitCode(payload: unknown, fallback = "CHILD_EXIT_NONZERO"): number {
  const reason = reasonCodeOf(payload, fallback);
  return MANAGED_EXECUTION_EXIT_CODE_BY_REASON[reason as keyof typeof MANAGED_EXECUTION_EXIT_CODE_BY_REASON] ?? 3;
}

function emitPayload(
  dependencies: CommandDependencies,
  options: ServiceCommandOptions,
  payload: unknown
): void {
  if (options.json === true) {
    dependencies.stdout(JSON.stringify(payload) + "\n");
    return;
  }
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    dependencies.stdout(`${String(record.action ?? record.status ?? record.reasonCode ?? "UNKNOWN")}\n`);
    return;
  }
  dependencies.stdout(String(payload) + "\n");
}

async function executeServiceAction(
  args: readonly string[],
  dependencies: CommandDependencies,
  options: ServiceCommandOptions,
  context: ServiceCommandContext
): Promise<{ payload: unknown; exitCode: number }> {
  const script = context.script ?? await findServiceScript(dependencies, "harness_service.py");
  const result = await runPythonJson({
    ...(context.runtime === undefined ? {} : { runtime: context.runtime }),
    projectRoot: resolve(dependencies.cwd),
    env: {
      ...dependencies.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8"
    },
    script,
    args: [...args, "--json"],
    onStderr: dependencies.stderr,
    budget: SERVICE_BUDGET,
    parse: (value) => value
  });
  if (result.value !== null) {
    return {
      payload: result.value,
      exitCode: exitCode(result.value, result.process.exitCode === 0 ? "SERVICE_READY" : "CHILD_EXIT_NONZERO")
    };
  }
  const payload = {
    ok: false,
    reasonCode: result.reasonCode,
    error: result.reasonCode === "PYTHON_RUNTIME_NOT_FOUND"
      ? "Python runtime unavailable"
      : "managed service command did not return typed JSON"
  };
  return { payload, exitCode: exitCode(payload, result.reasonCode) };
}

export async function runServiceEnsure(
  options: ServiceCommandOptions,
  dependencies: CommandDependencies,
  context: ServiceCommandContext = {}
): Promise<number> {
  if (!options.changeDir || !options.project) {
    const payload = { ok: false, reasonCode: "ARGUMENT_INVALID", error: "service ensure requires change-dir and project" };
    emitPayload(dependencies, options, payload);
    return 2;
  }
  const result = await executeServiceAction([
    "ensure",
    "--change-dir", resolve(options.changeDir),
    "--project", resolve(options.project),
    ...(options.files === undefined ? [] : ["--files", options.files]),
    ...(options.changeName === undefined ? [] : ["--change-name", options.changeName]),
    ...(options.overlay === undefined ? [] : ["--overlay", options.overlay]),
    ...(options.leasedPort === undefined ? [] : ["--leased-port", String(options.leasedPort)]),
    ...(options.leaseOwner === undefined ? [] : ["--lease-owner", options.leaseOwner]),
    ...(options.worktreeRoot === undefined ? [] : ["--worktree-root", resolve(options.worktreeRoot)]),
    ...(options.executionRoot === undefined ? [] : ["--execution-root", resolve(options.executionRoot)]),
    ...(options.attemptId === undefined ? [] : ["--attempt-id", options.attemptId])
  ], dependencies, options, context);
  emitPayload(dependencies, options, result.payload);
  return result.exitCode;
}

export async function runServiceStatus(
  options: ServiceCommandOptions,
  dependencies: CommandDependencies,
  context: ServiceCommandContext = {}
): Promise<number> {
  if (!options.changeDir) {
    const payload = { ok: false, reasonCode: "ARGUMENT_INVALID", error: "service status requires change-dir" };
    emitPayload(dependencies, options, payload);
    return 2;
  }
  const result = await executeServiceAction([
    "status",
    "--change-dir", resolve(options.changeDir),
    ...(options.files === undefined ? [] : ["--files", options.files])
  ], dependencies, options, context);
  emitPayload(dependencies, options, result.payload);
  return result.exitCode;
}

export async function runServiceStop(
  options: ServiceCommandOptions,
  dependencies: CommandDependencies,
  context: ServiceCommandContext = {}
): Promise<number> {
  if (!options.changeDir) {
    const payload = { ok: false, reasonCode: "ARGUMENT_INVALID", error: "service stop requires change-dir" };
    emitPayload(dependencies, options, payload);
    return 2;
  }
  const result = await executeServiceAction([
    "stop",
    "--change-dir", resolve(options.changeDir),
    ...(options.ifStartedByAi === true ? ["--if-started-by-ai"] : [])
  ], dependencies, options, context);
  emitPayload(dependencies, options, result.payload);
  return result.exitCode;
}

export async function runServiceRetireStale(
  options: ServiceCommandOptions,
  dependencies: CommandDependencies,
  context: ServiceCommandContext = {}
): Promise<number> {
  if (!options.changeDir) {
    const payload = { ok: false, reasonCode: "ARGUMENT_INVALID", error: "service retire-stale requires change-dir" };
    emitPayload(dependencies, options, payload);
    return 2;
  }
  const result = await executeServiceAction([
    "retire-stale",
    "--change-dir", resolve(options.changeDir)
  ], dependencies, options, context);
  emitPayload(dependencies, options, result.payload);
  return result.exitCode;
}

export async function runServiceLinkSuperseder(
  options: ServiceCommandOptions,
  dependencies: CommandDependencies,
  context: ServiceCommandContext = {}
): Promise<number> {
  if (!options.changeDir || !options.retirementReceipt) {
    const payload = { ok: false, reasonCode: "ARGUMENT_INVALID", error: "service link-superseder requires change-dir and retirement-receipt" };
    emitPayload(dependencies, options, payload);
    return 2;
  }
  const result = await executeServiceAction([
    "link-superseder",
    "--change-dir", resolve(options.changeDir),
    "--retirement-receipt", resolve(options.retirementReceipt)
  ], dependencies, options, context);
  emitPayload(dependencies, options, result.payload);
  return result.exitCode;
}
