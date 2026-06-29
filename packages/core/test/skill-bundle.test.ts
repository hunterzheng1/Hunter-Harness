import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileSkill, loadBootstrapBundle } from "@hunter-harness/core";
import type { RegistryAgent, SkillIr } from "@hunter-harness/contracts";

const bootstrapRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "resources",
  "bootstrap-ir"
);

function enabledProfile(ir: SkillIr): string {
  const entry = Object.entries(ir.profiles).find(([, p]) => p.enabled);
  if (entry === undefined) throw new Error(`seed ${ir.name} has no enabled profile`);
  return entry[0];
}

describe("bootstrap bundle cursor overlay (T16)", () => {
  it("loads 12 bootstrap seeds each with cursor adapter enabled", async () => {
    const bundle = await loadBootstrapBundle(bootstrapRoot);
    expect(bundle.skills).toHaveLength(12);
    for (const ir of bundle.skills) {
      expect(ir.adapters.cursor?.enabled).toBe(true);
    }
  });

  it("every seed compiles cursor to real .cursor/rules/<name>.mdc (non-placeholder) (INT-001 cursor)", async () => {
    const bundle = await loadBootstrapBundle(bootstrapRoot);
    for (const ir of bundle.skills) {
      const profile = enabledProfile(ir);
      const compiled = compileSkill(ir, {
        adapter: "cursor",
        profile,
        compilerVersion: bundle.compilerVersion
      });
      expect(compiled.path).toBe(`.cursor/rules/${ir.name}.mdc`);
      expect(compiled.adapter).toBe("cursor");
      expect(compiled.content).toContain("adapter: cursor");
      expect(compiled.content).not.toContain("Adapter contract placeholder");
    }
  });

  it("every seed compiles all 5 adapters (mcp placeholder, others real) (INT-001 smoke)", async () => {
    const bundle = await loadBootstrapBundle(bootstrapRoot);
    const agents = ["claude-code", "codex", "cursor", "generic", "mcp"] as const;
    for (const ir of bundle.skills) {
      const profile = enabledProfile(ir);
      for (const agent of agents) {
        const compiled = compileSkill(ir, {
          adapter: agent as RegistryAgent,
          profile,
          compilerVersion: bundle.compilerVersion
        });
        expect(compiled.adapter).toBe(agent);
        if (agent === "mcp") {
          expect(compiled.content).toContain("Adapter contract placeholder");
        } else {
          expect(compiled.content).not.toContain("Adapter contract placeholder");
        }
      }
    }
  });
});
