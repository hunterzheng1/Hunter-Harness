import {
  mkdtemp,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(
  new URL("../../../resources/bootstrap-ir", import.meta.url)
);

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("hunter-harness initialization", () => {
  let root: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-init-"));
    stdout = [];
    stderr = [];
  });

  async function run(args: string[]): Promise<number> {
    return runCli(args, {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
  }

  it("performs a write-free dry run", async () => {
    const code = await run([
      "--adapter", "claude-code",
      "--profile", "java",
      "--non-interactive",
      "--dry-run",
      "--json"
    ]);

    expect(code).toBe(0);
    expect(await pathExists(join(root, ".harness"))).toBe(false);
    const output = JSON.parse(stdout.join("")) as { dry_run: boolean; command: string };
    expect(output).toMatchObject({ dry_run: true, command: "configure" });
  });

  it("fails non-interactively when adapter or profile is missing", async () => {
    const code = await run(["--adapter", "claude-code", "--non-interactive", "--yes"]);
    expect(code).toBe(3);
    expect(stderr.join(" ")).toMatch(/profile/i);
    expect(await pathExists(join(root, ".harness"))).toBe(false);
  });

  it("prompts for missing interactive initialization fields", async () => {
    const answers = ["", ""];
    const code = await runCli([], {
      cwd: root,
      resourcesRoot,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      prompt: async () => answers.shift() ?? ""
    });

    expect(code).toBe(0);
    expect(await pathExists(join(root, ".harness", "project.yaml"))).toBe(true);
    expect(answers).toHaveLength(0);
    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as { project: { profiles: string[] }; adapters: { enabled: string[] } };
    expect(project.project.profiles).toEqual(["general"]);
    expect(project.adapters.enabled).toEqual(["claude-code"]);
  });

  it("initializes offline and compiles real Claude Code skills", async () => {
    const code = await run([
      "--adapter", "claude-code",
      "--profile", "java",
      "--non-interactive",
      "--yes"
    ]);
    expect(code).toBe(0);

    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as {
      project: { local_project_key: string; project_id: null; profiles: string[] };
      server: { url: null; token_env: string };
    };
    expect(project.project.local_project_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(project.project.project_id).toBeNull();
    expect(project.server).toEqual({
      url: null,
      token_env: "HUNTER_HARNESS_TOKEN"
    });
    expect(await pathExists(join(root, "AGENTS.md"))).toBe(true);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
    expect(await readFile(
      join(root, ".claude", "skills", "harness-review", "SKILL.md"),
      "utf8"
    )).toContain("source_ir_hash:");
    expect(await pathExists(join(root, ".harness", "rules"))).toBe(false);
    expect(await pathExists(join(root, ".harness", "state", "local"))).toBe(true);
    expect(await pathExists(
      join(root, ".harness", "cache", "server-artifacts")
    )).toBe(true);
    expect(await readFile(
      join(root, ".harness", "state", "baseline", "manifest.json"),
      "utf8"
    )).not.toContain("secret");
  });

  it("gives config-file fields precedence over command-line fields", async () => {
    const configPath = join(root, "harness.init.json");
    await writeFile(configPath, JSON.stringify({
      adapter: "claude-code",
      profile: "java",
      server_url: "https://config.example.com",
      token_env: "CONFIG_TOKEN",
      features: {
        codegraph_check: false,
        superpowers_check: false
      }
    }));

    const code = await run([
      "--config", configPath,
      "--adapter", "claude-code",
      "--profile", "general",
      "--server-url", "https://flag.example.com",
      "--non-interactive",
      "--yes"
    ]);
    expect(code).toBe(0);

    const project = parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ) as {
      project: { profiles: string[] };
      server: { url: string; token_env: string };
    };
    expect(project.project.profiles).toEqual(["java"]);
    expect(project.server).toEqual({
      url: "https://config.example.com",
      token_env: "CONFIG_TOKEN"
    });
  });

  it("preserves user content and is idempotent", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# User Claude\nKeep this.\n");
    await writeFile(join(root, "AGENTS.md"), "# User Agents\nKeep this too.\n");
    const args = [
      "--adapter", "claude-code",
      "--profile", "java",
      "--non-interactive",
      "--yes"
    ];
    expect(await run(args)).toBe(0);
    const firstClaude = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(await run(args)).toBe(0);
    const secondClaude = await readFile(join(root, "CLAUDE.md"), "utf8");

    expect(secondClaude).toBe(firstClaude);
    expect(secondClaude).toContain("# User Claude");
    expect(secondClaude.match(/hunter-harness:start/g)).toHaveLength(1);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("# User Agents");
  });
});
