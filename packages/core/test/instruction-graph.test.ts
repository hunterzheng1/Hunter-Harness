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
