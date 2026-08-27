import {
  mkdir,
  mkdtemp as osMkdtemp,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { stateLayout } from "@hunter-harness/core";

import { runCli } from "../src/bin.js";
import { seededInit } from "./seeded-init.js";
// Windows CI may expose TEMP through a junction. Canonicalize it before
// creating a recovery root; production rejects linked roots and internal
// path components while allowing a safe parent alias.
const tmpdir = (): string => realpathSync(osTmpdir());

async function mkdtemp(prefix: string): Promise<string> {
  return realpathSync(await osMkdtemp(prefix));
}

const resourcesRoot = fileURLToPath(
  new URL("../../workflow-data-harness", import.meta.url)
);

function outputCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    dependencies: {
      resourcesRoot,
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value)
    }
  };
}

describe("guarded default CLI", () => {
  it("initializes through preview/apply and returns a recovery receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-guarded-init-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-cli-recovery-"));
    const output = outputCapture();

    expect(await runCli([
      "--profile",
      "general",
      "--non-interactive",
      "--yes",
      "--recovery-root",
      recoveryRoot,
      "--json"
    ], {
      cwd: root,
      ...output.dependencies
    }), output.stderr.join("")).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      command: "configure",
      ok: true,
      plan_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      recovery_id: expect.stringMatching(/^tx_/)
    });
  });

  it("supports explicit init only for an absent project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-explicit-init-"));
    const first = outputCapture();
    expect(await runCli([
      "init", "--profile", "general", "--non-interactive", "--yes", "--json"
    ], {
      cwd: root,
      ...first.dependencies
    }), first.stderr.join("")).toBe(0);
    expect(JSON.parse(first.stdout.join(""))).toMatchObject({
      command: "configure",
      ok: true
    });

    const second = outputCapture();
    expect(await runCli([
      "init", "--profile", "general", "--non-interactive", "--yes", "--json"
    ], {
      cwd: root,
      ...second.dependencies
    })).toBe(6);
    expect(JSON.parse(second.stdout.join(""))).toMatchObject({
      command: "configure",
      ok: false,
      errors: [{ code: "PROJECT_ALREADY_INITIALIZED" }]
    });
  });

  it("keeps an already-current bare command byte-stable with no transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-guarded-noop-"));
    const first = outputCapture();
    // 种子：init 只做一次，拷贝复用；本用例关注的是二次裸命令的字节稳定性。
    await seededInit(root, "guarded-default-general", async (seedRoot) => {
      expect(await runCli([
        "--profile", "general", "--non-interactive", "--yes", "--json"
      ], {
        cwd: seedRoot,
        ...first.dependencies
      }), first.stderr.join("")).toBe(0);
    });
    const before = await readdir(stateLayout(root).transactions);
    const statePath = join(
      root,
      ".harness",
      "state",
      "local",
      "installed-harness-bundle.json"
    );
    const beforeState = await readFile(statePath, "utf8");

    const second = outputCapture();
    expect(await runCli([
      "--non-interactive", "--yes", "--json"
    ], {
      cwd: root,
      ...second.dependencies
    }), second.stderr.join("")).toBe(0);
    expect(JSON.parse(second.stdout.join(""))).toMatchObject({
      command: "refresh",
      recovery_id: null
    });
    expect(await readdir(stateLayout(root).transactions)).toEqual(before);
    expect(await readFile(statePath, "utf8")).toBe(beforeState);
  });

  it("routes update --guarded locally without calling the server", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-guarded-update-"));
    const init = outputCapture();
    await seededInit(root, "guarded-default-general", async (seedRoot) => {
      expect(await runCli([
        "--profile", "general", "--non-interactive", "--yes"
      ], {
        cwd: seedRoot,
        ...init.dependencies
      }), init.stderr.join("")).toBe(0);
    });
    const output = outputCapture();
    let fetchCalls = 0;

    expect(await runCli([
      "update", "--guarded", "--non-interactive", "--yes", "--json"
    ], {
      cwd: root,
      ...output.dependencies,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("server must not be called");
      }
    })).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      command: "refresh"
    });
  });

  it("does not turn --yes into permission to overwrite a local modification", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-guarded-preserve-"));
    const init = outputCapture();
    await seededInit(root, "guarded-default-general", async (seedRoot) => {
      expect(await runCli([
        "--profile", "general", "--non-interactive", "--yes"
      ], {
        cwd: seedRoot,
        ...init.dependencies
      }), init.stderr.join("")).toBe(0);
    });
    const target = join(root, ".claude", "agents", "harness-reviewer.md");
    await writeFile(target, "operator-owned content\n");
    const output = outputCapture();

    expect(await runCli([
      "--non-interactive", "--yes", "--json"
    ], {
      cwd: root,
      ...output.dependencies
    })).toBe(5);
    expect(await readFile(target, "utf8")).toBe("operator-owned content\n");
    const parsed = JSON.parse(output.stdout.join(""));
    expect(parsed.summary.conflicts).toBeGreaterThan(0);
    expect(parsed.items).toContainEqual(expect.objectContaining({
      target_path: ".claude/agents/harness-reviewer.md",
      status: "preserved"
    }));
  });

  it("keeps project and recovery identities safe in Chinese paths with spaces", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hunter-guarded-paths-"));
    const root = join(parent, "项目 空格");
    const recoveryRoot = join(parent, "恢复 空格");
    await mkdir(root, { recursive: true });
    const output = outputCapture();

    expect(await runCli([
      "--profile",
      "general",
      "--non-interactive",
      "--yes",
      "--recovery-root",
      recoveryRoot,
      "--json"
    ], {
      cwd: root,
      ...output.dependencies
    }), output.stderr.join("")).toBe(0);

    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      command: "configure",
      ok: true,
      recovery_id: expect.stringMatching(/^tx_/)
    });
    expect(new Set(await readdir(recoveryRoot))).toEqual(new Set([
      "index.json",
      "recoveries"
    ]));
  });
});
