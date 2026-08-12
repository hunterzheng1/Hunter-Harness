import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

describe("hunter-harness rules-review CLI", () => {
  it("exports pending candidates and applies a preconditioned user decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-rules-review-cli-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const run = (args: string[]) => runCli(args, {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(await run([
      "--profile", "general", "--agents", "all", "--non-interactive", "--yes"
    ])).toBe(0);
    await writeJson(
      join(root, ".harness", "state", "local", "rule-candidates.json"),
      {
        schema_version: 1,
        source_hashes: {},
        candidates: [{
          id: "rule_cli",
          status: "candidate",
          title: "Complete idempotency",
          proposed_rule: "Idempotent writes must persist and replay completed responses.",
          confidence: "high",
          severity: "red",
          occurrences: 2,
          evidence: []
        }]
      }
    );

    stdout.length = 0;
    expect(await run(["rules-review", "--json"])).toBe(0);
    const exported = JSON.parse(stdout.join("")) as {
      command: string;
      summary: { pending: number; decided: number };
      items: Array<{ candidate_id: string; candidate_revision: string }>;
    };
    expect(exported.command).toBe("rules-review");
    expect(exported.summary).toEqual({ pending: 1, decided: 0 });

    const target = join(root, ".harness", "rules", "testing.md");
    const before = "# Testing\n\nRun focused tests.\n";
    await mkdir(join(root, ".harness", "rules"), { recursive: true });
    await writeFile(target, before, "utf8");
    const after = before + "\n## Idempotency\n\nPersist and replay completed responses.\n";
    const decisions = join(root, "rule-decisions-input.json");
    await writeJson(decisions, {
      schema_version: 1,
      decisions: [{
        candidate_id: "rule_cli",
        candidate_revision: exported.items[0]?.candidate_revision,
        dispositions: ["public-rule", "regression-test"],
        reason: "Repeated review evidence shows a durable implementation invariant.",
        decided_at: "2026-07-24T00:00:00.000Z",
        rule_patch: {
          target_path: ".harness/rules/testing.md",
          expected_sha256: sha256(before),
          content: after
        }
      }]
    });

    stdout.length = 0;
    expect(await run(["rules-review", "--apply", decisions, "--json"])).toBe(0);
    const applied = JSON.parse(stdout.join("")) as {
      summary: { applied: number; recorded: number };
      remote_sync: { status: string; submitted: number; reason_code: string | null };
    };
    expect(applied.summary).toEqual({ applied: 1, recorded: 1 });
    expect(applied.remote_sync).toMatchObject({
      status: "deferred",
      submitted: 0
    });
    expect(await readFile(target, "utf8")).toBe(after);
  });
});
