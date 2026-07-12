import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildSemanticIndex } from "../src/semantic/indexer.js";
import { SemanticMemoryStore } from "../src/semantic/memory-store.js";

const fixtureRoot = fileURLToPath(new URL("../../../packages/contracts/test/fixtures/", import.meta.url));

describe("semantic indexer", () => {
  it("indexes knowledge ingest entries and markdown from artifact files", async () => {
    const entry = await readFile(join(fixtureRoot, "knowledge-ingest-entry.json"), "utf8");
    const build = buildSemanticIndex({
      projectId: "prj_sample",
      artifactId: "art_sample01",
      files: {
        ".harness/knowledge/entries/candidate/sample.json": entry,
        ".harness/knowledge/architecture/boundary.md": [
          "---",
          'id: "knowledge.architecture.boundary"',
          'type: "architecture"',
          'scope: "project"',
          'confidence: "verified"',
          'status: "active"',
          'domains: ["platform"]',
          'modules: ["core"]',
          'related_paths: ["packages/core/**"]',
          'source: {"kind":"design","ref":"docs/00-DESIGN.md"}',
          'created_at: "2026-06-20T00:00:00Z"',
          'updated_at: "2026-06-20T00:00:00Z"',
          'last_verified_at: "2026-06-20T00:00:00Z"',
          "expires_at: null",
          "supersedes: []",
          "superseded_by: []",
          "---",
          "",
          "Boundary stays explicit."
        ].join("\n"),
        "CLAUDE.md": "# Project\n",
        ".claude/rules/harness-general.md": "rule body\n"
      }
    });

    expect(build.documents.map((document) => document.kind)).toEqual([
      "rule",
      "knowledge_markdown",
      "knowledge_entry",
      "agent_instruction"
    ]);
    expect(build.documents.find((document) => document.kind === "knowledge_entry")).toMatchObject({
      title: "AI job 复用 LlmClient",
      metadata: { entry_type: "decision", status: "candidate" }
    });
  });

  it("rebuilds project semantic state idempotently in memory", () => {
    const store = new SemanticMemoryStore();
    const first = buildSemanticIndex({
      projectId: "prj_a",
      artifactId: "art_1",
      files: { "CLAUDE.md": "first\n" }
    });
    const second = buildSemanticIndex({
      projectId: "prj_a",
      artifactId: "art_2",
      files: { "CLAUDE.md": "second\n", "AGENTS.md": "agents\n" }
    });
    store.rebuild(first);
    store.rebuild(second);
    expect(store.listDocuments("prj_a")).toHaveLength(2);
    expect(store.latestArtifactId("prj_a")).toBe("art_2");
    expect(store.search("agents", "prj_a")).toHaveLength(1);
  });
});
