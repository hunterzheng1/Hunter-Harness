import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyRuleReviewDecisions,
  exportRuleReviewQueue
} from "../src/project/rule-review.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

describe("rule review lifecycle", () => {
  it("exports undecided candidates and suppresses an unchanged decided revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rule-review-"));
    const candidate = {
      id: "rule_one",
      status: "candidate",
      title: "Require complete idempotency",
      proposed_rule: "Idempotent writes must persist and replay the completed response.",
      confidence: "high",
      severity: "red",
      occurrences: 2,
      evidence: [
        {
          archive: "change-a",
          path: ".harness/archive/change-a/reports/review/review-findings.json",
          kind: "review",
          record_id: "R1"
        }
      ]
    };
    await writeJson(
      join(root, ".harness", "knowledge", "rule-candidates.json"),
      { schema_version: 1, source_hashes: {}, candidates: [candidate] }
    );

    const first = await exportRuleReviewQueue(root);
    expect(first.pending).toHaveLength(1);
    expect(first.pending[0]).toMatchObject({
      candidate_id: "rule_one",
      candidate
    });
    const revision = first.pending[0]?.candidate_revision;
    expect(revision).toMatch(/^[a-f0-9]{64}$/);

    await writeJson(
      join(root, ".harness", "knowledge", "rule-decisions.json"),
      {
        schema_version: 1,
        decisions: [{
          candidate_id: "rule_one",
          candidate_revision: revision,
          dispositions: ["reject"],
          reason: "The finding is implementation-specific.",
          decided_at: "2026-07-24T00:00:00.000Z"
        }]
      }
    );

    const second = await exportRuleReviewQueue(root);
    expect(second.pending).toEqual([]);
    expect(second.decided).toBe(1);
  });

  it("applies an approved public-rule patch and persists the decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rule-review-"));
    const target = join(root, ".harness", "rules", "testing.md");
    const before = "# Testing\n\nRun focused tests.\n";
    const after = [
      "# Testing",
      "",
      "Run focused tests.",
      "",
      "## Evidence invalidation",
      "",
      "Permission changes invalidate earlier full-suite evidence.",
      ""
    ].join("\n");
    await mkdir(join(root, ".harness", "rules"), { recursive: true });
    await writeFile(target, before, "utf8");
    await writeJson(
      join(root, ".harness", "knowledge", "rule-candidates.json"),
      {
        schema_version: 1,
        source_hashes: {},
        candidates: [{
          id: "rule_two",
          status: "candidate",
          title: "Invalidate stale evidence",
          proposed_rule: "Permission changes invalidate earlier full-suite evidence.",
          confidence: "high",
          severity: "red",
          occurrences: 2,
          evidence: []
        }]
      }
    );
    const queue = await exportRuleReviewQueue(root);
    const revision = queue.pending[0]?.candidate_revision;

    const result = await applyRuleReviewDecisions(root, {
      schema_version: 1,
      decisions: [{
        candidate_id: "rule_two",
        candidate_revision: revision ?? "",
        dispositions: ["public-rule", "regression-test"],
        reason: "This is a durable cross-workflow invariant.",
        decided_at: "2026-07-24T00:00:00.000Z",
        rule_patch: {
          target_path: ".harness/rules/testing.md",
          expected_sha256: sha256(before),
          content: after
        }
      }]
    });

    expect(result).toMatchObject({ applied: 1, recorded: 1 });
    expect(await readFile(target, "utf8")).toBe(after);
    expect(await readFile(
      join(root, ".harness", "knowledge", "rule-decisions.json"),
      "utf8"
    )).toContain("\"public-rule\"");
  });

  it("rejects a stale rule patch without modifying the target", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-rule-review-"));
    const target = join(root, ".harness", "rules", "testing.md");
    await mkdir(join(root, ".harness", "rules"), { recursive: true });
    await writeFile(target, "new local content\n", "utf8");
    await writeJson(
      join(root, ".harness", "knowledge", "rule-candidates.json"),
      {
        schema_version: 1,
        source_hashes: {},
        candidates: [{
          id: "rule_three",
          status: "candidate",
          title: "Safe patch",
          proposed_rule: "Use preconditioned writes.",
          confidence: "medium",
          severity: "yellow",
          occurrences: 2,
          evidence: []
        }]
      }
    );
    const queue = await exportRuleReviewQueue(root);

    await expect(applyRuleReviewDecisions(root, {
      schema_version: 1,
      decisions: [{
        candidate_id: "rule_three",
        candidate_revision: queue.pending[0]?.candidate_revision ?? "",
        dispositions: ["public-rule"],
        reason: "Approved after review.",
        decided_at: "2026-07-24T00:00:00.000Z",
        rule_patch: {
          target_path: ".harness/rules/testing.md",
          expected_sha256: sha256("old content\n"),
          content: "replacement\n"
        }
      }]
    })).rejects.toThrow(/RULE_PATCH_STALE/);
    expect(await readFile(target, "utf8")).toBe("new local content\n");
  });
});
