import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runTransaction, stateLayout } from "@hunter-harness/core";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(
  new URL("../../workflow-data-harness", import.meta.url)
);

function capture() {
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

describe("context-aware default and recovery commands", () => {
  it("bare command initializes an absent project and guarded-refreshes a valid project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-default-"));
    const first = capture();
    expect(await runCli(["--non-interactive", "--yes", "--json"], {
      cwd: root,
      ...first.dependencies
    })).toBe(0);
    expect(JSON.parse(first.stdout.join(""))).toMatchObject({
      command: "configure",
      ok: true
    });

    const transactionsBefore = await readdir(stateLayout(root).transactions);
    const second = capture();
    expect(await runCli(["--non-interactive", "--yes", "--json"], {
      cwd: root,
      ...second.dependencies
    })).toBe(0);
    expect(JSON.parse(second.stdout.join(""))).toMatchObject({
      command: "refresh",
      ok: true,
      summary: { applied: 0 }
    });
    expect(await readdir(stateLayout(root).transactions)).toEqual(
      transactionsBefore
    );
  });

  it("status reports pending recovery without mutating the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-status-"));
    expect(await runCli(["--profile", "general", "--non-interactive", "--yes"], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    const target = join(root, "status.md");
    await writeFile(target, "before\n");
    await expect(runTransaction(root, [{
      operation: "modify",
      path: "status.md",
      content: "after\n"
    }], {
      id: "tx_status_pending",
      kind: "update",
      interruptAfterApply: 1
    })).rejects.toThrow();
    const before = await readFile(target, "utf8");

    const output = capture();
    expect(await runCli(["status", "--json"], {
      cwd: root,
      ...output.dependencies
    })).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      status: "RECOVERY_REQUIRED",
      mutationState: "APPLIED_PARTIAL",
      pending: [{
        transactionId: "tx_status_pending",
        recoveryId: "tx_status_pending"
      }]
    });
    expect(await readFile(target, "utf8")).toBe(before);
  });

  it("recover inspect and resume expose stable non-interactive recovery actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-resume-"));
    expect(await runCli(["--profile", "general", "--non-interactive", "--yes"], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    const target = join(root, "resume.md");
    await writeFile(target, "before\n");
    await expect(runTransaction(root, [{
      operation: "modify",
      path: "resume.md",
      content: "after\n"
    }], {
      id: "tx_resume_pending",
      kind: "update",
      interruptAfterApply: 1
    })).rejects.toThrow();

    const inspect = capture();
    expect(await runCli([
      "recover", "tx_resume_pending", "--action", "inspect", "--json",
      "--non-interactive"
    ], {
      cwd: root,
      ...inspect.dependencies
    })).toBe(0);
    expect(JSON.parse(inspect.stdout.join(""))).toMatchObject({
      status: "RECOVERY_REQUIRED",
      recoveryId: "tx_resume_pending",
      mutationState: "APPLIED_PARTIAL",
      recommendedAction: "resume"
    });
    expect(await readFile(target, "utf8")).toBe("after\n");

    const invalid = capture();
    expect(await runCli([
      "recover", "tx_resume_pending", "--action", "rollbak", "--json",
      "--non-interactive", "--yes"
    ], {
      cwd: root,
      ...invalid.dependencies
    })).toBe(2);
    expect(invalid.stderr.join("")).toContain("RECOVERY_ACTION_INVALID");
    expect(await readFile(target, "utf8")).toBe("after\n");

    const resume = capture();
    expect(await runCli([
      "resume", "tx_resume_pending", "--json",
      "--non-interactive", "--yes"
    ], {
      cwd: root,
      ...resume.dependencies
    })).toBe(0);
    expect(JSON.parse(resume.stdout.join(""))).toMatchObject({
      status: "COMMITTED",
      recoveryId: "tx_resume_pending",
      mutationState: "COMMITTED"
    });
    expect(await readFile(target, "utf8")).toBe("after\n");
  });
});
