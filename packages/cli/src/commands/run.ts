import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  runPythonJson,
  type ManagedProcessBudget,
  type PythonRuntimeResolution
} from "@hunter-harness/core";
import { MANAGED_EXECUTION_EXIT_CODE_BY_REASON } from "@hunter-harness/contracts";

import type { CommandDependencies } from "./configure.js";

export type RunAction = "start" | "status" | "log" | "cancel";

export interface RunCommandOptions {
  stateRoot?: string;
  verification?: string;
  workingDirectory?: string;
  timeoutSeconds?: number;
  heartbeatSeconds?: number;
  expectedDurationSeconds?: number;
  productIdentity?: string;
  resourceLock?: string[];
  sessionId?: string;
  stream?: "stdout" | "stderr";
  cursor?: number;
  maxBytes?: number;
  json?: boolean;
}

export interface RunCommandContext {
  runtime?: PythonRuntimeResolution;
  script?: string;
}

const DEFAULT_BUDGET: ManagedProcessBudget = {
  wallTimeoutMs: 90_000,
  stallTimeoutMs: 30_000,
  heartbeatMs: 10_000,
  terminateGraceMs: 2_000
};

async function findRuntimeScript(
  dependencies: CommandDependencies,
  name: string
): Promise<string> {
  const resources = dependencies.resourcesRoot;
  const candidates = [
    join(resources, "harness", "bundles", "general", "codex", "scripts", name),
    join(resources, "harness", "bundles", "general", "claude-code", "scripts", name),
    join(resources, "scripts", name),
    join(dependencies.cwd, "harness", "scripts", name),
    join(dependencies.cwd, name)
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return resolve(candidate);
    } catch {
      // Continue through the deterministic source/bundle candidates.
    }
  }
  return resolve(candidates[0] ?? join(dependencies.cwd, name));
}

function reasonCodeOf(payload: unknown, fallback: string): string {
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["reasonCode", "code"]) {
      if (typeof record[key] === "string" && record[key].length > 0) {
        return record[key];
      }
    }
  }
  return fallback;
}

export function managedExecutionExitCode(payload: unknown, fallback = "CHILD_EXIT_NONZERO"): number {
  const reason = reasonCodeOf(payload, fallback);
  return MANAGED_EXECUTION_EXIT_CODE_BY_REASON[reason as keyof typeof MANAGED_EXECUTION_EXIT_CODE_BY_REASON] ?? 3;
}

async function executeRuntimeAction(
  action: RunAction,
  args: readonly string[],
  dependencies: CommandDependencies,
  options: RunCommandOptions,
  context: RunCommandContext
): Promise<{ payload: unknown; exitCode: number }> {
  const script = context.script ?? await findRuntimeScript(dependencies, "harness_runtime.py");
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
    budget: DEFAULT_BUDGET,
    parse: (value) => value
  });
  if (result.value !== null) {
    const exitCode = managedExecutionExitCode(result.value, result.process.exitCode === 0 ? "CHILD_EXIT_ZERO" : "CHILD_EXIT_NONZERO");
    return { payload: result.value, exitCode };
  }
  const payload = {
    ok: false,
    reasonCode: result.reasonCode,
    error: result.reasonCode === "PYTHON_RUNTIME_NOT_FOUND"
      ? "Python runtime unavailable"
      : "managed execution command failed"
  };
  return { payload, exitCode: managedExecutionExitCode(payload, result.reasonCode) };
}

function emitRunPayload(
  dependencies: CommandDependencies,
  options: RunCommandOptions,
  payload: unknown
): void {
  if (options.json === true) {
    dependencies.stdout(JSON.stringify(payload) + "\n");
    return;
  }
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    dependencies.stdout(`${String(record.status ?? record.action ?? record.reasonCode ?? "UNKNOWN")}\n`);
    return;
  }
  dependencies.stdout(String(payload) + "\n");
}

function stateRoot(options: RunCommandOptions, dependencies: CommandDependencies): string {
  return resolve(options.stateRoot ?? join(dependencies.cwd, ".harness"));
}

export async function runRunStart(
  options: RunCommandOptions,
  argv: readonly string[],
  dependencies: CommandDependencies,
  context: RunCommandContext = {}
): Promise<number> {
  if (!options.verification || argv.length === 0) {
    const payload = { ok: false, reasonCode: "ARGUMENT_INVALID", error: "run start requires verification and argv" };
    emitRunPayload(dependencies, options, payload);
    return 2;
  }
  const args = [
    "run-start",
    "--state-root", stateRoot(options, dependencies),
    "--verification", options.verification,
    "--working-directory", resolve(options.workingDirectory ?? dependencies.cwd),
    ...(options.timeoutSeconds === undefined ? [] : ["--timeout-seconds", String(options.timeoutSeconds)]),
    ...(options.heartbeatSeconds === undefined ? [] : ["--heartbeat-seconds", String(options.heartbeatSeconds)]),
    ...(options.expectedDurationSeconds === undefined ? [] : ["--expected-duration-seconds", String(options.expectedDurationSeconds)]),
    ...(options.productIdentity === undefined ? [] : ["--product-identity", options.productIdentity]),
    ...(options.resourceLock ?? []).flatMap((lock) => ["--resource-lock", lock]),
    "--",
    ...argv
  ];
  const result = await executeRuntimeAction("start", args, dependencies, options, context);
  emitRunPayload(dependencies, options, result.payload);
  return result.exitCode;
}

export async function runRunStatus(
  options: RunCommandOptions,
  dependencies: CommandDependencies,
  context: RunCommandContext = {}
): Promise<number> {
  if (!options.sessionId) {
    const payload = { ok: false, reasonCode: "ARGUMENT_INVALID", error: "run status requires sessionId" };
    emitRunPayload(dependencies, options, payload);
    return 2;
  }
  const result = await executeRuntimeAction("status", [
    "run-status",
    "--state-root", stateRoot(options, dependencies),
    "--session-id", options.sessionId
  ], dependencies, options, context);
  emitRunPayload(dependencies, options, result.payload);
  return result.exitCode;
}

export async function runRunLog(
  options: RunCommandOptions,
  dependencies: CommandDependencies,
  context: RunCommandContext = {}
): Promise<number> {
  if (!options.sessionId) {
    const payload = { ok: false, reasonCode: "ARGUMENT_INVALID", error: "run log requires sessionId" };
    emitRunPayload(dependencies, options, payload);
    return 2;
  }
  const result = await executeRuntimeAction("log", [
    "run-log",
    "--state-root", stateRoot(options, dependencies),
    "--session-id", options.sessionId,
    "--stream", options.stream ?? "stdout",
    "--cursor", String(options.cursor ?? 0),
    "--max-bytes", String(options.maxBytes ?? 64 * 1024)
  ], dependencies, options, context);
  emitRunPayload(dependencies, options, result.payload);
  return result.exitCode;
}

export async function runRunCancel(
  options: RunCommandOptions,
  dependencies: CommandDependencies,
  context: RunCommandContext = {}
): Promise<number> {
  if (!options.sessionId) {
    const payload = { ok: false, reasonCode: "ARGUMENT_INVALID", error: "run cancel requires sessionId" };
    emitRunPayload(dependencies, options, payload);
    return 2;
  }
  const result = await executeRuntimeAction("cancel", [
    "run-cancel",
    "--state-root", stateRoot(options, dependencies),
    "--session-id", options.sessionId
  ], dependencies, options, context);
  emitRunPayload(dependencies, options, result.payload);
  return result.exitCode;
}
