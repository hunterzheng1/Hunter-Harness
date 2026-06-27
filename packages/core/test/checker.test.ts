import { describe, expect, it } from "vitest";

import type { SkillIr, SourceFile } from "@hunter-harness/contracts";
import { checkSkill } from "../src/index.js";

const baseIr: SkillIr = {
  name: "harness-x",
  kind: "governance",
  description: "demo skill",
  triggers: ["run"],
  inputs: ["ctx"],
  outputs: ["out"],
  forbidden_actions: ["automatic_git_write"],
  required_context: ["AGENTS.md"],
  profiles: { general: { enabled: true } },
  adapters: { "claude-code": { enabled: true } },
  version: "1.0.0"
};

const baseFiles: SourceFile[] = [
  { path: "SKILL.md", content: "# harness-x skill" },
  { path: "references/ref.md", content: "reference doc" },
  { path: "scripts/run.sh", content: "echo hi" }
];

const PRIVATE_KEY_CONTENT = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAo\n-----END PRIVATE KEY-----";

describe("checkSkill", () => {
  it("returns all green when everything passes", () => {
    const r = checkSkill({ ir: baseIr, sourceFiles: baseFiles, latestVersion: null, compilerVersion: "1", checkedAt: "2026-06-26T00:00:00Z" });
    expect(r.summary.red).toBe(0);
    expect(r.items.every((i) => i.status === "green")).toBe(true);
  });

  it("flags SENSITIVE red when private key present", () => {
    const r = checkSkill({ ir: baseIr, sourceFiles: [{ path: "secret.md", content: PRIVATE_KEY_CONTENT }], latestVersion: null, compilerVersion: "1", checkedAt: "t" });
    expect(r.items.find((i) => i.id === "SENSITIVE")?.status).toBe("red");
  });

  it("flags VERSION red when ir.version not forward of latest", () => {
    const r = checkSkill({ ir: baseIr, sourceFiles: baseFiles, latestVersion: "2.0.0", compilerVersion: "1", checkedAt: "t" });
    expect(r.items.find((i) => i.id === "VERSION")?.status).toBe("red");
  });

  it("flags FILE_PATH red on path traversal", () => {
    const r = checkSkill({ ir: baseIr, sourceFiles: [{ path: "../escape.md", content: "x" }], latestVersion: null, compilerVersion: "1", checkedAt: "t" });
    expect(r.items.find((i) => i.id === "FILE_PATH")?.status).toBe("red");
  });

  it("flags PERMISSIONS yellow when Bash(*) in allowed_capabilities", () => {
    const r = checkSkill({ ir: { ...baseIr, allowed_capabilities: ["Bash(*)"] }, sourceFiles: baseFiles, latestVersion: null, compilerVersion: "1", checkedAt: "t" });
    const perm = r.items.find((i) => i.id === "PERMISSIONS");
    expect(perm?.status === "yellow" || perm?.status === "red").toBe(true);
  });

  it("marks STRUCTURE green when references and scripts present", () => {
    const r = checkSkill({ ir: baseIr, sourceFiles: baseFiles, latestVersion: null, compilerVersion: "1", checkedAt: "t" });
    expect(r.items.find((i) => i.id === "STRUCTURE")?.status).toBe("green");
  });

  it("summary counts are consistent (green+yellow+red == items.length)", () => {
    const r = checkSkill({ ir: { ...baseIr, allowed_capabilities: ["Bash(*)"] }, sourceFiles: [{ path: "../x.md", content: PRIVATE_KEY_CONTENT }], latestVersion: "2.0.0", compilerVersion: "1", checkedAt: "t" });
    expect(r.summary.green + r.summary.yellow + r.summary.red).toBe(r.items.length);
    expect(r.summary.red).toBeGreaterThan(0);
  });

  it("flags NAMING non-green when ir.name is not kebab-case (UT-014)", () => {
    const r = checkSkill({
      ir: { ...baseIr, name: "Harness_X" },
      sourceFiles: baseFiles,
      latestVersion: null,
      compilerVersion: "1",
      checkedAt: "t"
    });
    expect(r.items.find((i) => i.id === "NAMING")?.status).not.toBe("green");
  });

  it("flags DESCRIPTION yellow when ir.description is empty (UT-015)", () => {
    const r = checkSkill({
      ir: { ...baseIr, description: "" },
      sourceFiles: baseFiles,
      latestVersion: null,
      compilerVersion: "1",
      checkedAt: "t"
    });
    expect(r.items.find((i) => i.id === "DESCRIPTION")?.status).toBe("yellow");
  });

  it("flags ENTRY_SKILL_MD green when SKILL.md present (UT-001)", () => {
    const r = checkSkill({ ir: baseIr, sourceFiles: baseFiles, latestVersion: null, compilerVersion: "1", checkedAt: "t" });
    expect(r.items.find((i) => i.id === "ENTRY_SKILL_MD")?.status).toBe("green");
  });

  it("flags ENTRY_SKILL_MD red when SKILL.md missing (UT-002)", () => {
    const r = checkSkill({ ir: baseIr, sourceFiles: [{ path: "skill.yaml", content: "x" }], latestVersion: null, compilerVersion: "1", checkedAt: "t" });
    expect(r.items.find((i) => i.id === "ENTRY_SKILL_MD")?.status).toBe("red");
  });

  it("flags DESCRIPTION yellow when description > 500 chars (UT-006)", () => {
    const r = checkSkill({ ir: { ...baseIr, description: "x".repeat(600) }, sourceFiles: baseFiles, latestVersion: null, compilerVersion: "1", checkedAt: "t" });
    expect(r.items.find((i) => i.id === "DESCRIPTION")?.status).toBe("yellow");
  });

  it("flags DESCRIPTION red when description > 2000 chars (UT-007)", () => {
    const r = checkSkill({ ir: { ...baseIr, description: "x".repeat(2100) }, sourceFiles: baseFiles, latestVersion: null, compilerVersion: "1", checkedAt: "t" });
    expect(r.items.find((i) => i.id === "DESCRIPTION")?.status).toBe("red");
  });

  it("flags PERMISSIONS red when dangerous command rm -rf in instructions (UT-009)", () => {
    const r = checkSkill({ ir: { ...baseIr, instructions: ["run rm -rf /"] }, sourceFiles: baseFiles, latestVersion: null, compilerVersion: "1", checkedAt: "t" });
    expect(r.items.find((i) => i.id === "PERMISSIONS")?.status).toBe("red");
  });

  it("flags PERMISSIONS yellow when network access undeclared (UT-011)", () => {
    const r = checkSkill({ ir: { ...baseIr, instructions: ["fetch https://example.com"] }, sourceFiles: baseFiles, latestVersion: null, compilerVersion: "1", checkedAt: "t" });
    const perm = r.items.find((i) => i.id === "PERMISSIONS");
    expect(perm?.status === "yellow" || perm?.status === "red").toBe(true);
  });

  it("AGENT_TARGET maps codex agent path (UT-014)", () => {
    const r = checkSkill({ ir: { ...baseIr, adapters: { codex: { enabled: true } } }, sourceFiles: baseFiles, latestVersion: null, compilerVersion: "1", checkedAt: "t" });
    const agent = r.items.find((i) => i.id === "AGENT_TARGET");
    expect(agent?.status).not.toBe("red");
    expect(agent?.message).toContain("codex");
  });
});
