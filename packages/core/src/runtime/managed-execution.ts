import { spawn } from "node:child_process";

import {
  resolvePythonRuntime,
  type PythonRuntimeResolution
} from "./python.js";

export interface ManagedProcessBudget {
  wallTimeoutMs: number;
  stallTimeoutMs?: number;
  heartbeatMs?: number;
  terminateGraceMs?: number;
}

export interface ManagedProcessResult {
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

export interface TypedJsonResult<T> {
  process: ManagedProcessResult;
  value: T | null;
  reasonCode: "OK" | "PYTHON_RUNTIME_NOT_FOUND" | "CHILD_EXIT_NONZERO" | "TYPED_OUTPUT_INVALID";
}

function boundedOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (value.length <= maxBytes) return { value, truncated: false };
  return { value: value.slice(0, maxBytes), truncated: true };
}

export async function runManagedProcess(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  onStderr: (value: string) => void,
  budgetInput: number | ManagedProcessBudget = 15 * 60 * 1000
): Promise<ManagedProcessResult> {
  const budget: ManagedProcessBudget = typeof budgetInput === "number"
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
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, argv.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      const stderr = error instanceof Error ? error.message : "spawn failed";
      resolveProcess({
        exitCode: 1,
        stdout: "",
        stderr,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        lastActivityAt: startedAt,
        timedOut: false,
        timeoutKind: null,
        termination: "spawn-error",
        signal: null,
        heartbeatCount: 0,
        stdoutTruncated: false,
        stderrTruncated: false
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let lastActivityMs = startedAtMs;
    let activityObserved = false;
    let timedOut = false;
    let timeoutKind: ManagedProcessResult["timeoutKind"] = null;
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
    const wallTimer = setTimeout(() => terminate("wall"), Math.max(1, budget.wallTimeoutMs));
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
      termination: ManagedProcessResult["termination"],
      signal: NodeJS.Signals | null
    ): void => {
      if (settled) return;
      settled = true;
      stopTimers();
      const completedAtMs = Date.now();
      const reportedActivityMs = activityObserved
        ? Math.max(lastActivityMs, startedAtMs + 1)
        : lastActivityMs;
      const stdoutBounded = boundedOutput(stdout, 16 * 1024 * 1024);
      const stderrBounded = boundedOutput(stderr, 4 * 1024 * 1024);
      resolveProcess({
        exitCode,
        stdout: stdoutBounded.value,
        stderr: stderrBounded.value,
        startedAt,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
        lastActivityAt: new Date(reportedActivityMs).toISOString(),
        timedOut,
        timeoutKind,
        termination,
        signal,
        heartbeatCount,
        stdoutTruncated: stdoutTruncated || stdoutBounded.truncated,
        stderrTruncated: stderrTruncated || stderrBounded.truncated
      });
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      activityObserved = true;
      lastActivityMs = Date.now();
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) stdoutTruncated = true;
    });
    child.stderr?.on("data", (chunk: string) => {
      activityObserved = true;
      lastActivityMs = Date.now();
      stderr += chunk;
      if (stderr.length > 4 * 1024 * 1024) stderrTruncated = true;
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

export interface RunPythonJsonOptions<T> {
  runtime?: PythonRuntimeResolution;
  projectRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  script: string;
  args?: readonly string[];
  onStderr?: (value: string) => void;
  budget?: number | ManagedProcessBudget;
  parse: (value: unknown) => T;
}

export async function runPythonJson<T>(
  options: RunPythonJsonOptions<T>
): Promise<TypedJsonResult<T>> {
  const runtime = options.runtime ?? await resolvePythonRuntime({
    projectRoot: options.projectRoot,
    env: options.env
  });
  if (!runtime.available) {
    return {
      process: {
        exitCode: 3,
        stdout: "",
        stderr: "Python runtime unavailable",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        lastActivityAt: new Date().toISOString(),
        timedOut: false,
        timeoutKind: null,
        termination: "spawn-error",
        signal: null,
        heartbeatCount: 0,
        stdoutTruncated: false,
        stderrTruncated: false
      },
      value: null,
      reasonCode: "PYTHON_RUNTIME_NOT_FOUND"
    };
  }
  const process = await runManagedProcess(
    [...runtime.argvPrefix, options.script, ...(options.args ?? [])],
    options.projectRoot,
    { ...options.env, PYTHONDONTWRITEBYTECODE: "1" },
    options.onStderr ?? (() => undefined),
    options.budget
  );
  if (process.exitCode !== 0) {
    return { process, value: null, reasonCode: "CHILD_EXIT_NONZERO" };
  }
  try {
    return {
      process,
      value: options.parse(JSON.parse(process.stdout)),
      reasonCode: "OK"
    };
  } catch {
    return { process, value: null, reasonCode: "TYPED_OUTPUT_INVALID" };
  }
}
