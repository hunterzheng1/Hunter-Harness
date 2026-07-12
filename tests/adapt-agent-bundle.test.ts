import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { adaptBundleDir } from "../scripts/adapt-agent-bundle.mjs";

async function writeSkill(
  root: string,
  name: string,
  frontmatter: string,
  body: string
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\n${frontmatter}\n---\n\n${body}\n`,
    "utf8"
  );
}

describe("adaptBundleDir", () => {
  it("codex skill keeps only name+description and body must be clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapt-codex-"));
    await writeSkill(
      dir,
      "harness-demo",
      [
        "name: harness-demo",
        "description: demo skill for adaptation",
        "allowed-tools: [Read]",
        "effort: high"
      ].join("\n"),
      "# Demo\n\nUse PowerShell and report evidence.\n"
    );

    const report = await adaptBundleDir(dir, "codex");
    const text = await readFile(join(dir, "harness-demo", "SKILL.md"), "utf8");
    const fm = text.split("---")[1] ?? "";
    expect(fm).toContain("name:");
    expect(fm).toContain("description:");
    expect(fm).not.toContain("allowed-tools");
    expect(fm).not.toContain("effort");
    expect(report.rewritten).toContain("harness-demo/SKILL.md");
  });

  it("claude-code bundle is byte-identical passthrough", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapt-claude-"));
    await writeSkill(
      dir,
      "harness-demo",
      [
        "name: harness-demo",
        "description: demo",
        "allowed-tools: [Read]",
        "effort: high"
      ].join("\n"),
      "# Demo\n\n.claude/rules/ are fine for Claude.\n"
    );
    const before = await readFile(join(dir, "harness-demo", "SKILL.md"));
    const beforeHash = createHash("sha256").update(before).digest("hex");
    await adaptBundleDir(dir, "claude-code");
    const after = await readFile(join(dir, "harness-demo", "SKILL.md"));
    expect(createHash("sha256").update(after).digest("hex")).toBe(beforeHash);
  });

  it("fails when non-claude body references .claude/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapt-path-"));
    await writeSkill(
      dir,
      "harness-demo",
      "name: harness-demo\ndescription: demo",
      "Read .claude/rules/harness-general.md\n"
    );
    await expect(adaptBundleDir(dir, "codex")).rejects.toThrow(/\.claude\//);
  });

  it("fails when codex/cursor body requires custom agent spawn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapt-spawn-"));
    await writeSkill(
      dir,
      "harness-demo",
      "name: harness-demo\ndescription: demo",
      "Use Agent with subagent_type: harness-reviewer\n"
    );
    await expect(adaptBundleDir(dir, "codex")).rejects.toThrow(/custom agent/);
    await expect(adaptBundleDir(dir, "cursor")).rejects.toThrow(/custom agent/);
  });

  it("fails when skill dir name != frontmatter name or description empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapt-name-"));
    await writeSkill(
      dir,
      "harness-demo",
      "name: harness-other\ndescription: demo",
      "# Demo\n"
    );
    await expect(adaptBundleDir(dir, "codex")).rejects.toThrow(/name/);

    const dir2 = await mkdtemp(join(tmpdir(), "adapt-desc-"));
    await writeSkill(dir2, "harness-demo", "name: harness-demo\ndescription: \"\"", "# Demo\n");
    await expect(adaptBundleDir(dir2, "codex")).rejects.toThrow(/description/);
  });

  it("codebuddy agents keep only confirmed fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapt-cb-"));
    await mkdir(join(dir, "agents"), { recursive: true });
    await writeFile(
      join(dir, "agents", "demo.md"),
      [
        "---",
        "name: demo",
        "description: demo agent",
        "model: sonnet",
        "effort: high",
        "maxTurns: 12",
        "memory: project",
        "permissionMode: default",
        "skills: [harness-review]",
        "tools: [Read]",
        "---",
        "",
        "# Demo",
        ""
      ].join("\n"),
      "utf8"
    );
    await adaptBundleDir(dir, "codebuddy");
    const text = await readFile(join(dir, "agents", "demo.md"), "utf8");
    const fm = text.split("---")[1] ?? "";
    expect(fm).toContain("name:");
    expect(fm).toContain("description:");
    expect(fm).toContain("permissionMode:");
    expect(fm).toContain("skills:");
    expect(fm).not.toContain("model:");
    expect(fm).not.toContain("effort:");
    expect(fm).not.toContain("maxTurns:");
    expect(fm).not.toContain("memory:");
    expect(fm).not.toContain("tools:");
  });

  it("fails on unresolved include or {{ placeholder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapt-ph-"));
    await writeSkill(
      dir,
      "harness-demo",
      "name: harness-demo\ndescription: demo",
      "<!-- @include shared/x.md -->\n"
    );
    await expect(adaptBundleDir(dir, "claude-code")).rejects.toThrow(/@include/);

    const dir2 = await mkdtemp(join(tmpdir(), "adapt-mustache-"));
    await writeSkill(
      dir2,
      "harness-demo",
      "name: harness-demo\ndescription: demo",
      "Hello {{NAME}}\n"
    );
    await expect(adaptBundleDir(dir2, "codex")).rejects.toThrow(/PLACEHOLDER|NAME|\{\{/);
  });
});
