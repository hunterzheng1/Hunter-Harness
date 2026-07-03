import { describe, expect, it } from "vitest";

import type { SourceFile } from "@hunter-harness/contracts";

import { checkSkill } from "../src/skill/checker.js";

const fm = (name: string, extra: Record<string, unknown> = {}): string => {
  const lines = ["---", `name: ${name}`, "description: d"];
  for (const [k, v] of Object.entries(extra)) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "body");
  return lines.join("\n");
};

const baseInput = (files: SourceFile[], latestVersion: string | null = null) => ({
  sourceFiles: files,
  agent: "claude-code" as const,
  latestVersion,
  compilerVersion: "v1",
  checkedAt: "2026-07-03T00:00:00Z"
});

const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAo\n-----END PRIVATE KEY-----";

const skillFile = (content: string): SourceFile => ({ path: "SKILL.md", content });

describe("checkSkill (source-file driven)", () => {
  it("UT-009 entry exists → ENTRY_SKILL_MD green", () => {
    const r = checkSkill(baseInput([skillFile(fm("harness-x"))]));
    expect(r.items.find((i) => i.id === "ENTRY_SKILL_MD")?.status).toBe("green");
  });

  it("UT-010 entry missing → ENTRY_SKILL_MD red", () => {
    const r = checkSkill(baseInput([{ path: "ref.md", content: "x" }]));
    expect(r.items.find((i) => i.id === "ENTRY_SKILL_MD")?.status).toBe("red");
  });

  it("UT-011 sensitive content → SENSITIVE red", () => {
    const r = checkSkill(baseInput([skillFile(fm("harness-x") + "\n" + PRIVATE_KEY)]));
    expect(r.items.find((i) => i.id === "SENSITIVE")?.status).toBe("red");
  });

  it("UT-012 no forbidden_actions → PERMISSIONS not red (suggestion)", () => {
    const r = checkSkill(baseInput([skillFile(fm("harness-x"))]));
    const perm = r.items.find((i) => i.id === "PERMISSIONS");
    expect(perm?.status).not.toBe("red");
  });

  it("VERSION red when frontmatter version not forward of latest", () => {
    const r = checkSkill(baseInput([skillFile(fm("harness-x", { version: "1.0.0" }))], "2.0.0"));
    expect(r.items.find((i) => i.id === "VERSION")?.status).toBe("red");
  });

  it("VERSION green when frontmatter version forward of latest", () => {
    const r = checkSkill(baseInput([skillFile(fm("harness-x", { version: "2.0.0" }))], "1.0.0"));
    expect(r.items.find((i) => i.id === "VERSION")?.status).toBe("green");
  });

  it("FILE_PATH red on path traversal", () => {
    const r = checkSkill(baseInput([{ path: "../escape.md", content: "x" }]));
    expect(r.items.find((i) => i.id === "FILE_PATH")?.status).toBe("red");
  });

  it("PERMISSIONS red when dangerous command rm -rf in body", () => {
    const r = checkSkill(baseInput([skillFile(fm("harness-x") + "\nrun rm -rf /")]));
    expect(r.items.find((i) => i.id === "PERMISSIONS")?.status).toBe("red");
  });

  it("PERMISSIONS red when RM -RF uppercase (case-insensitive)", () => {
    const r = checkSkill(baseInput([skillFile(fm("harness-x") + "\nrun RM -RF /")]));
    expect(r.items.find((i) => i.id === "PERMISSIONS")?.status).toBe("red");
  });

  it("DESCRIPTION yellow when > 500 chars", () => {
    const longDesc = "x".repeat(600);
    const r = checkSkill(baseInput([skillFile(`---\nname: harness-x\ndescription: ${longDesc}\n---\nbody`)]));
    expect(r.items.find((i) => i.id === "DESCRIPTION")?.status).toBe("yellow");
  });

  it("STRUCTURE green when references and scripts present", () => {
    const r = checkSkill(baseInput([
      skillFile(fm("harness-x")),
      { path: "references/ref.md", content: "ref" },
      { path: "scripts/run.sh", content: "echo" }
    ]));
    expect(r.items.find((i) => i.id === "STRUCTURE")?.status).toBe("green");
  });

  it("summary counts are consistent", () => {
    const r = checkSkill(baseInput([{ path: "../x.md", content: PRIVATE_KEY }], "2.0.0"));
    expect(r.summary.green + r.summary.yellow + r.summary.red).toBe(r.items.length);
    expect(r.summary.red).toBeGreaterThan(0);
  });
});
