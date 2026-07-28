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
});
