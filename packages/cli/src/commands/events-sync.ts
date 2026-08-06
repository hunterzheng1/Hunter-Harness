import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { uuidV7 } from "@hunter-harness/core";

import { serializeCliResult, type CliResult } from "../output/json.js";
import type { CommandDependencies } from "./configure.js";

export interface EventsSyncOptions {
  changeDir?: string;
  heartbeatOnly?: boolean;
  json?: boolean;
}

function scriptsDirFromResources(resourcesRoot: string): string {
  return join(resourcesRoot, "harness", "scripts");
}

async function resolveSyncScript(resourcesRoot: string): Promise<string | null> {
  const candidates = [
    join(scriptsDirFromResources(resourcesRoot), "harness_events_sync.py"),
    // Monorepo / source checkout fallback.
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "harness", "scripts", "harness_events_sync.py")
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function runPython(script: string, args: string[], cwd: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn("python", [script, ...args], {
      cwd,
      env: process.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: String(error) });
    });
  });
}

/**
 * `hunter-harness events-sync` — headless wrapper around harness_events_sync.py.
 * Uploads events.ndjson batches + heartbeats to the platform Run monitoring API.
 */
export async function runEventsSync(
  options: EventsSyncOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const requestId = uuidV7();
  const script = await resolveSyncScript(dependencies.resourcesRoot);
  if (script === null) {
    const message = "harness_events_sync.py not found in workflow resources";
    dependencies.stderr(message + "\n");
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "events-sync",
        request_id: requestId,
        dry_run: false,
        ok: false,
        exit_code: 3,
        project_id: null,
        summary: {},
        items: [],
        warnings: [],
        errors: [{ code: "SCRIPT_MISSING", message }]
      }));
    }
    return 3;
  }

  const args = ["--project", dependencies.cwd, "--json"];
  if (options.changeDir !== undefined && options.changeDir.trim() !== "") {
    args.push("--change-dir", options.changeDir);
  }
  if (options.heartbeatOnly === true) {
    args.push("--heartbeat-only");
  }

  const result = await runPython(script, args, dependencies.cwd);
  let payload: Record<string, unknown> | null;
  try {
    payload = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    payload = null;
  }

  const ok = result.code === 0 && payload?.ok !== false;
  if (options.json === true) {
    const envelope: CliResult = {
      schema_version: 1,
      command: "events-sync",
      request_id: requestId,
      dry_run: false,
      ok,
      exit_code: (ok ? 0 : 1) as CliResult["exit_code"],
      project_id: null,
      summary: {
        uploaded: typeof payload?.results === "object" ? "batch" : 0
      },
      items: Array.isArray(payload?.results) ? payload.results as unknown[] : [],
      warnings: result.stderr.trim() === "" ? [] : [{ message: result.stderr.trim().slice(0, 500) }],
      errors: ok
        ? []
        : [{ code: "EVENTS_SYNC_FAILED", message: result.stderr.trim() || "events sync failed" }]
    };
    dependencies.stdout(serializeCliResult(envelope));
  } else if (result.stdout.trim() !== "") {
    dependencies.stdout(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
  } else if (!ok) {
    dependencies.stderr((result.stderr || "events sync failed") + "\n");
  }
  return ok ? 0 : 1;
}
