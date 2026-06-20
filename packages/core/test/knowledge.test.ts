import { describe, expect, it } from "vitest";

import {
  buildContextIndex,
  buildKnowledgeIndex,
  parseKnowledgeMarkdown,
  rebuildKnowledgeIndex,
  validateCandidatePromotion
} from "../src/index.js";

function knowledge(overrides: Record<string, unknown> = {}, body = "Current fact.\n"): string {
  const values = {
    id: "knowledge.architecture.boundary",
    type: "architecture",
    scope: "project",
    confidence: "verified",
    status: "active",
    domains: ["platform"],
    modules: ["core"],
    related_paths: ["packages/core/**"],
    source: { kind: "design", ref: "docs/00-DESIGN.md" },
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-10T00:00:00Z",
    last_verified_at: "2026-06-10T00:00:00Z",
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    ...overrides
  };
  return "---\n" + Object.entries(values).map(([key, value]) =>
    key + ": " + JSON.stringify(value)
  ).join("\n") + "\n---\n\n" + body;
}

describe("Knowledge indexing", () => {
  it("parses strict frontmatter and marks expired active entries stale", () => {
    const parsed = parseKnowledgeMarkdown(
      knowledge({ expires_at: "2026-06-15T00:00:00Z" }),
      "architecture/boundary.md"
    );
    const index = buildKnowledgeIndex([parsed], {
      now: new Date("2026-06-20T00:00:00Z")
    });

    expect(parsed.summary).toBe("Current fact.");
    expect(index.entries[0]).toMatchObject({
      id: "knowledge.architecture.boundary",
      status: "stale",
      path: "architecture/boundary.md",
      local: false
    });
  });

  it("rejects duplicate IDs and canonical content", () => {
    const first = parseKnowledgeMarkdown(knowledge(), "architecture/one.md");
    const duplicateId = parseKnowledgeMarkdown(
      knowledge({}, "Different fact.\n"),
      "architecture/two.md"
    );
    expect(() => buildKnowledgeIndex([first, duplicateId])).toThrow(/duplicate id/i);

    const duplicateContent = parseKnowledgeMarkdown(
      knowledge({ id: "knowledge.architecture.copy" }),
      "architecture/copy.md"
    );
    expect(() => buildKnowledgeIndex([first, duplicateContent])).toThrow(
      /duplicate content/i
    );
  });

  it("rejects supersedes cycles and inconsistent reverse links", () => {
    const first = parseKnowledgeMarkdown(knowledge({
      id: "knowledge.decision.first",
      type: "decision",
      status: "superseded",
      supersedes: ["knowledge.decision.second"],
      superseded_by: ["knowledge.decision.second"]
    }, "First decision.\n"), "decisions/first.md");
    const second = parseKnowledgeMarkdown(knowledge({
      id: "knowledge.decision.second",
      type: "decision",
      supersedes: ["knowledge.decision.first"],
      superseded_by: ["knowledge.decision.first"]
    }, "Second decision.\n"), "decisions/second.md");
    expect(() => buildKnowledgeIndex([first, second])).toThrow(/cycle/i);
  });

  it("excludes project-local entries by default", () => {
    const local = parseKnowledgeMarkdown(knowledge({
      id: "knowledge.local.secret-context",
      type: "project-local",
      scope: "local"
    }), "project-local/context.md");

    expect(buildKnowledgeIndex([local]).entries).toEqual([]);
    expect(buildKnowledgeIndex([local], { includeLocal: true }).entries[0]).toMatchObject({
      local: true,
      path: "project-local/context.md"
    });
  });

  it("keeps candidate promotion review-bound", () => {
    const candidate = parseKnowledgeMarkdown(knowledge({
      id: "knowledge.pitfall.candidate",
      type: "pitfall",
      status: "candidate",
      confidence: "inferred"
    }), "_candidates/pitfall.md");
    expect(validateCandidatePromotion(candidate)).toEqual({
      candidate_id: "knowledge.pitfall.candidate",
      target_status: "active",
      requires_server_review: true
    });

    const invalid = parseKnowledgeMarkdown(knowledge({
      id: "knowledge.pitfall.unreviewed",
      type: "pitfall",
      status: "candidate",
      confidence: "verified"
    }), "_candidates/unreviewed.md");
    expect(() => validateCandidatePromotion(invalid)).toThrow(/confidence/i);
  });

  it("builds deterministic context routing without embedding all content", () => {
    const context = buildContextIndex({
      rules: [".claude/rules/harness-general.md"],
      enabledSkills: ["harness-review", "harness-sync"],
      mapStatus: "fresh",
      codegraphAvailable: false,
      knowledgeIndexHash: "sha256:abc"
    });
    expect(context).toMatchObject({
      schema_version: 1,
      knowledge: { index: ".harness/knowledge/index.json", hash: "sha256:abc" },
      codebase: { map: ".harness/codebase/map", status: "fresh" },
      integrations: { codegraph: { available: false, managed: false } }
    });
    expect(context.skills).toEqual(["harness-review", "harness-sync"]);
  });

  it("rebuilds index.json atomically from Markdown entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-knowledge-"));
    await mkdir(join(root, "architecture"), { recursive: true });
    await mkdir(join(root, "project-local"), { recursive: true });
    await writeFile(join(root, "architecture", "boundary.md"), knowledge());
    await writeFile(join(root, "project-local", "private.md"), knowledge({
      id: "knowledge.local.private",
      type: "project-local",
      scope: "local"
    }, "Private context.\n"));

    const index = await rebuildKnowledgeIndex(root, {
      now: new Date("2026-06-20T00:00:00Z")
    });
    expect(index.entries.map((entry) => entry.id)).toEqual([
      "knowledge.architecture.boundary"
    ]);
    expect(JSON.parse(await readFile(join(root, "index.json"), "utf8"))).toEqual(index);
  });
});
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
