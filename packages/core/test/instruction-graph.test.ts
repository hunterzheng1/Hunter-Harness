import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateInstructionGraph } from "../src/index.js";

describe("instruction graph validator", () => {
  it("SYNC-ENTRY-001 accepts a thin CLAUDE → AGENTS → context-index graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-instruction-graph-"));
    try {
      await mkdir(join(root, ".harness", "rules"), { recursive: true });
      await writeFile(join(root, "CLAUDE.md"), "Read and follow @AGENTS.md.\n");
      await writeFile(
        join(root, "AGENTS.md"),
        "Use `.harness/context-index.json` to locate project guidance.\n"
      );
      await writeFile(
        join(root, ".harness", "context-index.json"),
        JSON.stringify({
          project: {
            shared_instructions: "AGENTS.md",
            adapters: {
              "claude-code": { instructions: "CLAUDE.md" }
            }
          },
          rules: [
            ".harness/rules/architecture.md",
            ".harness/rules/testing.md",
            ".harness/rules/coding-style.md",
            ".harness/rules/build.md",
            ".harness/rules/stack.md"
          ]
        })
      );
      for (const name of ["architecture", "testing", "coding-style", "build", "stack"]) {
        await writeFile(
          join(root, ".harness", "rules", `${name}.md`),
          `# ${name}\nEffective ${name} guidance.\n`
        );
      }

      const result = await validateInstructionGraph(root, "CLAUDE.md");

      expect(result.status).toBe("OK");
      expect(result.entrypointIntegrity.status).toBe("OK");
      expect(result.unresolvedReferences).toEqual([]);
      expect(result.effectiveGuidanceTopics).toMatchObject({
        architecture: { status: "OK" },
        testing: { status: "OK" },
        codingStyle: { status: "OK" },
        build: { status: "OK" },
        stack: { status: "OK" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-ENTRY-002 rejects cycles and missing references", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-instruction-cycle-"));
    try {
      await writeFile(join(root, "CLAUDE.md"), "Read @AGENTS.md and @MISSING.md.\n");
      await writeFile(join(root, "AGENTS.md"), "Read @CLAUDE.md.\n");

      const result = await validateInstructionGraph(root, "CLAUDE.md");

      expect(result.status).toBe("FAIL");
      expect(result.entrypointIntegrity.reasonCodes).toEqual(expect.arrayContaining([
        "INSTRUCTION_REFERENCE_CYCLE",
        "INSTRUCTION_REFERENCE_MISSING"
      ]));
      expect(result.unresolvedReferences).toContain("MISSING.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-001 follows typed config edges but never recurses into generated state", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-instruction-typed-"));
    try {
      await mkdir(join(root, ".harness", "rules"), { recursive: true });
      await mkdir(join(root, ".harness", "knowledge"), { recursive: true });
      await mkdir(join(root, ".harness", "archive"), { recursive: true });
      await writeFile(join(root, "CLAUDE.md"), "Read @AGENTS.md.\n");
      await writeFile(
        join(root, "AGENTS.md"),
        "Use `.harness/context-index.json` for architecture, testing, build, stack and coding style.\n"
      );
      await writeFile(
        join(root, ".harness", "context-index.json"),
        JSON.stringify({
          project: {
            shared_instructions: "AGENTS.md",
            adapters: { codex: { instructions: "CLAUDE.md" } }
          },
          rules: [".harness/rules/architecture.md"],
          knowledge: { index: ".harness/knowledge/index.json" },
          archive: { latest: ".harness/archive/latest.json" }
        })
      );
      await writeFile(
        join(root, ".harness", "rules", "architecture.md"),
        "# architecture\nTesting, build, stack and coding style guidance.\n"
      );
      await writeFile(
        join(root, ".harness", "knowledge", "index.json"),
        JSON.stringify({ entries: [{ path: ".harness/archive/latest.json" }] })
      );
      await writeFile(
        join(root, ".harness", "archive", "latest.json"),
        JSON.stringify({ path: ".harness/knowledge/index.json" })
      );

      const result = await validateInstructionGraph(root, "CLAUDE.md");
      const typed = result as typeof result & {
        edges: Array<{ from: string; to: string; type: string }>;
        diagnostics: { edgeTypeCounts: Record<string, number> };
      };
      expect(result.reachableFiles).toContain(".harness/rules/architecture.md");
      expect(result.reachableFiles).not.toContain(".harness/knowledge/index.json");
      expect(result.reachableFiles).not.toContain(".harness/archive/latest.json");
      expect(typed.edges.some((edge) => edge.type === "catalog")).toBe(true);
      expect(typed.edges.some((edge) => edge.type === "ownership")).toBe(true);
      expect(typed.diagnostics.edgeTypeCounts.include).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-002 bounds missing-reference diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-instruction-bounded-"));
    try {
      const references = Array.from(
        { length: 80 },
        (_, index) => `@missing-${index}.md`
      ).join("\n");
      await writeFile(join(root, "CLAUDE.md"), references);
      const result = await validateInstructionGraph(root, "CLAUDE.md");
      const typed = result as typeof result & {
        diagnostics: { unresolvedCount: number; unresolvedOmitted: number };
      };
      expect(result.unresolvedReferences).toHaveLength(50);
      expect(typed.diagnostics.unresolvedCount).toBe(80);
      expect(typed.diagnostics.unresolvedOmitted).toBe(30);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-PATH-01 resolves a root-relative reference from the project root, not the document dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-instruction-path-root-"));
    try {
      await mkdir(join(root, "docs", "ai"), { recursive: true });
      await writeFile(
        join(root, "docs", "ai", "readme.md"),
        "See `docs/ai/example.json` for budgets.\n"
      );
      await writeFile(join(root, "docs", "ai", "example.json"), "{}\n");

      const result = await validateInstructionGraph(root, "docs/ai/readme.md");
      const typed = result as typeof result & {
        edges: Array<{ to: string; traversed: boolean; resolutionTrace?: { selectedRoot: string | null; attemptedRoots: string[] } }>;
      };

      expect(result.reachableFiles).toContain("docs/ai/example.json");
      expect(result.reachableFiles).not.toContain("docs/ai/docs/ai/example.json");
      const edge = typed.edges.find((candidate) => candidate.to === "docs/ai/example.json");
      expect(edge?.traversed).toBe(true);
      expect(edge?.resolutionTrace?.selectedRoot).toBe("project-root");
      expect(edge?.resolutionTrace?.attemptedRoots).toEqual(
        expect.arrayContaining(["project-root", "document-relative"])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-PATH-02 resolves a ./ reference from the document directory only", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-instruction-path-doc-"));
    try {
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(
        join(root, "docs", "notes.md"),
        "See `./example.json` for context.\n"
      );
      await writeFile(join(root, "docs", "example.json"), "{\"scope\":\"docs\"}\n");
      await writeFile(join(root, "example.json"), "{\"scope\":\"root\"}\n");

      const result = await validateInstructionGraph(root, "docs/notes.md");
      const typed = result as typeof result & {
        edges: Array<{ to: string; traversed: boolean; resolutionTrace?: { selectedRoot: string | null; attemptedRoots: string[] } }>;
      };

      expect(result.reachableFiles).toContain("docs/example.json");
      expect(result.reachableFiles).not.toContain("example.json");
      const edge = typed.edges.find((candidate) => candidate.to === "docs/example.json");
      expect(edge?.traversed).toBe(true);
      expect(edge?.resolutionTrace?.selectedRoot).toBe("document-relative");
      expect(edge?.resolutionTrace?.attemptedRoots).toEqual(["document-relative"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-PATH-03 uses the Markdown link target, not the display text", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-instruction-path-link-"));
    try {
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(
        join(root, "docs", "guide.md"),
        "See [docs/other.json](../example.json) for details.\n"
      );
      await writeFile(join(root, "example.json"), "{}\n");

      const result = await validateInstructionGraph(root, "docs/guide.md");
      const typed = result as typeof result & {
        edges: Array<{
          to: string;
          traversed: boolean;
          resolutionTrace?: { rawToken: string; tokenType: string; selectedRoot: string | null };
        }>;
      };

      expect(result.reachableFiles).toContain("example.json");
      expect(result.unresolvedReferences).not.toContain("docs/other.json");
      const edge = typed.edges.find((candidate) => candidate.to === "example.json");
      expect(edge?.traversed).toBe(true);
      expect(edge?.resolutionTrace?.rawToken).toBe("../example.json");
      expect(edge?.resolutionTrace?.tokenType).toBe("markdown-link");
      expect(edge?.resolutionTrace?.selectedRoot).toBe("document-relative");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-PATH-04 rejects a reference that escapes the project root, recording a resolution trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-instruction-path-escape-"));
    try {
      await writeFile(join(root, "CLAUDE.md"), "See `../../outside.json` here.\n");

      const result = await validateInstructionGraph(root, "CLAUDE.md");
      const typed = result as typeof result & {
        edges: Array<{
          to: string;
          traversed: boolean;
          reason: string | null;
          resolutionTrace?: { selectedPath: string | null; rejectionReason: string | null };
        }>;
      };

      expect(result.entrypointIntegrity.reasonCodes).toContain(
        "INSTRUCTION_REFERENCE_OUTSIDE_PROJECT"
      );
      const edge = typed.edges.find((candidate) => candidate.to === "../../outside.json");
      expect(edge?.traversed).toBe(false);
      expect(edge?.reason).toBe("outside-project");
      expect(edge?.resolutionTrace?.selectedPath).toBeNull();
      expect(edge?.resolutionTrace?.rejectionReason).toBe("outside-project");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-PATH-05 treats a missing bare inline-code filename as prose, not a required include", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-instruction-inline-prose-"));
    try {
      await writeFile(
        join(root, "CLAUDE.md"),
        [
          "# architecture testing coding style build stack",
          "Worktree verification depends on `build-profile.json`; report WARN when it is absent."
        ].join("\n") + "\n"
      );

      const result = await validateInstructionGraph(root, "CLAUDE.md");
      const edge = result.edges.find((candidate) =>
        candidate.resolutionTrace?.rawToken === "build-profile.json"
      );

      expect(result.status).toBe("OK");
      expect(result.entrypointIntegrity.status).toBe("OK");
      expect(result.unresolvedReferences).toEqual([]);
      expect(edge).toMatchObject({
        traversed: false,
        reason: "informational-inline-code-missing"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-PATH-06 still rejects a missing path-qualified inline-code reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-instruction-inline-path-"));
    try {
      await writeFile(
        join(root, "CLAUDE.md"),
        "Architecture, testing, coding style, build and stack are defined in `docs/ai/missing.json`.\n"
      );

      const result = await validateInstructionGraph(root, "CLAUDE.md");

      expect(result.status).toBe("FAIL");
      expect(result.entrypointIntegrity.reasonCodes).toContain(
        "INSTRUCTION_REFERENCE_MISSING"
      );
      expect(result.unresolvedReferences).toContain("docs/ai/missing.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("SYNC-003 rejects an oversized include before reading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-instruction-budget-"));
    try {
      await writeFile(join(root, "CLAUDE.md"), "Read @large.md.\n");
      await writeFile(join(root, "large.md"), "x".repeat(600 * 1024));
      const result = await validateInstructionGraph(root, "CLAUDE.md");
      expect(result.entrypointIntegrity.reasonCodes).toContain(
        "INSTRUCTION_GRAPH_BUDGET_EXCEEDED"
      );
      expect(result.reachableFiles).not.toContain("large.md");
      expect(result.totalBytes).toBeLessThanOrEqual(512 * 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
