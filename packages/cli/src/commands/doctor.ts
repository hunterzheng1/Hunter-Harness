import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ManagedBlockStructureError,
  parseManagedBlocks
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { resolvePythonRuntime } from "../runtime/python.js";

export interface DoctorCommandOptions {
  runtime?: boolean;
  managedBlocks?: boolean;
  json?: boolean;
}

export async function runDoctor(
  options: DoctorCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const runtimeRequested = options.runtime === true ||
    options.managedBlocks !== true;
  const python = runtimeRequested
    ? await resolvePythonRuntime({
      projectRoot: dependencies.cwd,
      env: dependencies.env
    })
    : null;
  const findings: Array<{
    path: string;
    code: string;
    message: string;
    repairPreview: string;
  }> = [];
  if (options.managedBlocks === true) {
    for (const relativePath of ["AGENTS.md", "CLAUDE.md", "CODEBUDDY.md"]) {
      try {
        parseManagedBlocks(
          await readFile(join(dependencies.cwd, relativePath), "utf8")
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          continue;
        }
        if (error instanceof ManagedBlockStructureError) {
          findings.push({
            path: relativePath,
            code: error.code,
            message: error.message,
            repairPreview:
              "Preserve user-authored content; repair marker pairs manually or apply a reviewed block-level artifact."
          });
          continue;
        }
        throw error;
      }
    }
  }
  const runtimeFailed = python !== null && !python.available;
  const status = runtimeFailed ? "FAIL" : findings.length > 0 ? "WARN" : "OK";
  const payload = {
    schemaVersion: 1,
    status,
    reasonCode: runtimeFailed
      ? "PYTHON_RUNTIME_UNAVAILABLE"
      : findings.length > 0
        ? "MANAGED_BLOCK_STRUCTURE_INVALID"
        : "OK",
    ...(python === null ? {} : { runtime: { python } }),
    managedBlocks: {
      checked: options.managedBlocks === true,
      findings
    }
  };
  dependencies.stdout(JSON.stringify(payload) + "\n");
  return runtimeFailed ? 4 : findings.length > 0 ? 5 : 0;
}
