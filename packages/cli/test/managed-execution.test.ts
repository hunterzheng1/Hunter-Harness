import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runRunStart,
  runRunStatus
} from "../src/commands/run.js";
import { runServiceEnsure } from "../src/commands/service.js";

function dependencies(root: string, output: string[]): Parameters<typeof runRunStart>[2] {
  return {
    cwd: root,
    resourcesRoot: root,
    stdout: (value) => output.push(value),
    stderr: () => undefined,
    prompt: async () => "",
    fetch: globalThis.fetch,
    env: {}
  };
}

function runtime(): NonNullable<Parameters<typeof runRunStart>[3]>["runtime"] {
  return {
    available: true,
    source: "python",
    executable: process.execPath,
    argvPrefix: [process.execPath, "-e"],
    version: "node-test",
    attempts: []
  };
}

describe("managed execution CLI transport", () => {
  it("passes run argv as typed JSON without shell reconstruction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-cli-run-"));
    const output: string[] = [];
    const result = await runRunStart(
      { verification: "unit", json: true },
      ["child", "a b", "中文"],
      dependencies(root, output),
      {
        runtime: runtime(),
        script: "process.stdout.write(JSON.stringify({ok:true,status:'RUNNING',reasonCode:'SERVICE_READY',argv:process.argv.slice(1)}))"
      }
    );
    expect(result).toBe(0);
    expect(JSON.parse(output[0] ?? "{}").argv).toContain("a b");
    expect(JSON.parse(output[0] ?? "{}").argv).toContain("中文");
  });

  it("returns stable runtime-missing JSON instead of spawning a fallback shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-cli-runtime-"));
    const output: string[] = [];
    const result = await runRunStatus(
      { sessionId: "missing", json: true },
      dependencies(root, output),
      {
        runtime: {
          available: false,
          source: "unavailable",
          executable: null,
          argvPrefix: [],
          version: "",
          attempts: []
        },
        script: "unused"
      }
    );
    expect(result).toBe(3);
    expect(JSON.parse(output[0] ?? "{}").reasonCode).toBe("PYTHON_RUNTIME_NOT_FOUND");
  });

  it("maps typed service mutation conflicts to exit code four", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-cli-service-"));
    const output: string[] = [];
    const result = await runServiceEnsure(
      { changeDir: root, project: root, json: true },
      dependencies(root, output),
      {
        runtime: runtime(),
        script: "process.stdout.write(JSON.stringify({ok:false,code:'SERVICE_MUTATION_CONFLICT',reasonCode:'SERVICE_MUTATION_CONFLICT'}))"
      }
    );
    expect(result).toBe(4);
    expect(JSON.parse(output[0] ?? "{}").reasonCode).toBe("SERVICE_MUTATION_CONFLICT");
  });
});
