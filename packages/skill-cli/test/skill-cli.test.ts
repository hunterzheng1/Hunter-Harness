import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AdmZip from "adm-zip";
import { sha256Bytes } from "@hunter-harness/core";
import { describe, expect, it, vi } from "vitest";

import { runSkillCli } from "../src/bin.js";

const tokenEnv = { HH_SKILL_TOKEN: "test-token" };

function zipBytes(content = "# harness-sync\n"): Buffer {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(content));
  zip.addFile("hunter-skill.json", Buffer.from(JSON.stringify({
    schema_version: 1,
    slug: "harness-sync",
    version: "1.0.0",
    agent: "claude-code",
    target_path: ".claude/skills/harness-sync/SKILL.md"
  })));
  return zip.toBuffer();
}

// 簇B cursor fixture：zip 内文件名 harness-sync.mdc（非 SKILL.md），target_path=.cursor/rules/<slug>.mdc，
// 对齐 server buildArtifacts 的 cursor 产出（ADAPTERS.cursor.targetPath）。schema_version=2 对齐 server MANIFEST_SCHEMA_VERSION。
function zipBytesCursor(content = "# harness-sync\n"): Buffer {
  const zip = new AdmZip();
  zip.addFile("harness-sync.mdc", Buffer.from(content));
  zip.addFile("hunter-skill.json", Buffer.from(JSON.stringify({
    schema_version: 2,
    slug: "harness-sync",
    version: "1.0.0",
    agent: "cursor",
    target_path: ".cursor/rules/harness-sync.mdc"
  })));
  return zip.toBuffer();
}

describe("@hunter-harness/skill-cli", () => {
  it("prints help with a successful exit code", async () => {
    const output: string[] = [];
    const exitCode = await runSkillCli(["node", "skill-cli", "--help"], {
      env: {},
      stdout: (value) => output.push(value),
      stderr: () => undefined
    });

    expect(exitCode).toBe(0);
    expect(output.join("")).toContain("install");
    expect(output.join("")).toContain("upload");
  });
  it("installs, no-ops on an identical artifact, and refuses a dirty overwrite", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-install-"));
    const artifact = zipBytes();
    const fetch = vi.fn(async (input: string | URL) => {
      expect(String(input)).toContain("/api/v1/skills/harness-sync/artifacts/claude-code/download");
      return new Response(artifact, {
        status: 200,
        headers: { "x-content-sha256": sha256Bytes(artifact) }
      });
    });
    const output: string[] = [];
    const args = [
      "node", "skill-cli", "install", "harness-sync",
      "--agent", "claude-code",
      "--server-url", "https://harness.example",
      "--token-env", "HH_SKILL_TOKEN",
      "--json"
    ];
    expect(await runSkillCli(args, {
      cwd, env: tokenEnv, fetch, stdout: (value) => output.push(value), stderr: () => undefined
    })).toBe(0);
    expect(await readFile(join(cwd, ".claude/skills/harness-sync/SKILL.md"), "utf8"))
      .toBe("# harness-sync\n");

    expect(await runSkillCli(args, {
      cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined
    })).toBe(0);

    await writeFile(join(cwd, ".claude/skills/harness-sync/SKILL.md"), "local edit\n");
    expect(await runSkillCli(args, {
      cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined
    })).toBe(5);
    expect(await readFile(join(cwd, ".claude/skills/harness-sync/SKILL.md"), "utf8"))
      .toBe("local edit\n");
  });

  it("does not overwrite an unmanaged existing skill without explicit confirmation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-unmanaged-"));
    const target = join(cwd, ".claude", "skills", "harness-sync");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "local unmanaged skill\n");
    const artifact = zipBytes("server skill\n");
    const fetch = vi.fn(async () => new Response(artifact, {
      status: 200,
      headers: { "x-content-sha256": sha256Bytes(artifact) }
    }));
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync", "--agent", "claude-code",
      "--server-url", "https://harness.example", "--token-env", "HH_SKILL_TOKEN"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined });
    expect(exitCode).toBe(5);
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("local unmanaged skill\n");
  });
  it("uploads a directory as a review proposal and exposes no publish command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-upload-"));
    const source = join(cwd, "candidate");
    await mkdir(source);
    await writeFile(join(source, "skill.yaml"), [
      "name: harness-candidate",
      "kind: tooling",
      "description: Candidate skill",
      "triggers: [candidate]",
      "inputs: []",
      "outputs: [report]",
      "forbidden_actions: [automatic_git_write]",
      "required_context: [AGENTS.md]",
      "profiles: { general: { enabled: true } }",
      "adapters: { claude-code: { enabled: true } }",
      "version: 1.0.0"
    ].join("\n"));
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.skill_ir.name).toBe("harness-candidate");
      return Response.json({ proposal_id: "skp_candidate", status: "pending_review" }, { status: 201 });
    });
    expect(await runSkillCli([
      "node", "skill-cli", "upload", source,
      "--agent", "claude-code", "--server-url", "https://harness.example",
      "--token-env", "HH_SKILL_TOKEN", "--json"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined })).toBe(0);

    expect(await runSkillCli(["node", "skill-cli", "publish"], {
      cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined
    })).toBe(3);
  });

  it("installs cursor agent to .cursor/rules/<slug>.mdc with manifest.agent=cursor (INT-102)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-cursor-install-"));
    const artifact = zipBytesCursor();
    const fetch = vi.fn(async (input: string | URL) => {
      expect(String(input)).toContain("/api/v1/skills/harness-sync/artifacts/cursor/download");
      return new Response(artifact, {
        status: 200,
        headers: { "x-content-sha256": sha256Bytes(artifact) }
      });
    });
    const output: string[] = [];
    const args = [
      "node", "skill-cli", "install", "harness-sync",
      "--agent", "cursor",
      "--server-url", "https://harness.example",
      "--token-env", "HH_SKILL_TOKEN",
      "--json"
    ];
    expect(await runSkillCli(args, {
      cwd, env: tokenEnv, fetch, stdout: (v) => output.push(v), stderr: () => undefined
    })).toBe(0);
    expect(await readFile(join(cwd, ".cursor/rules/harness-sync.mdc"), "utf8"))
      .toBe("# harness-sync\n");
    const manifest = JSON.parse(await readFile(
      join(cwd, ".harness", "state", "local", "skill-installs", "harness-sync.json"), "utf8"
    ));
    expect(manifest.agent).toBe("cursor");
    expect(manifest.files).toHaveProperty("harness-sync.mdc");
  });

  it("uploads with agent=cursor passthrough to /skill-proposals (INT-103)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-cursor-upload-"));
    const source = join(cwd, "candidate");
    await mkdir(source);
    await writeFile(join(source, "skill.yaml"), [
      "name: harness-candidate",
      "kind: tooling",
      "description: Candidate skill",
      "triggers: [candidate]",
      "inputs: []",
      "outputs: [report]",
      "forbidden_actions: [automatic_git_write]",
      "required_context: [AGENTS.md]",
      "profiles: { general: { enabled: true } }",
      "adapters: { cursor: { enabled: true } }",
      "version: 1.0.0"
    ].join("\n"));
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.agent).toBe("cursor");
      return Response.json({ proposal_id: "skp_cursor", status: "pending_review" }, { status: 201 });
    });
    expect(await runSkillCli([
      "node", "skill-cli", "upload", source,
      "--agent", "cursor", "--server-url", "https://harness.example",
      "--token-env", "HH_SKILL_TOKEN", "--json"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined })).toBe(0);
  });

  it("rejects install with unsupported agent (codex) ADAPTER_UNSUPPORTED exit 3 (白名单边界回归)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-codex-"));
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync", "--agent", "codex",
      "--server-url", "https://harness.example", "--token-env", "HH_SKILL_TOKEN"
    ], { cwd, env: tokenEnv, fetch: vi.fn(), stdout: () => undefined, stderr: () => undefined });
    expect(exitCode).toBe(3);
  });

  // harness-review 加固：target_path 防逃逸校验按路径片段判断，不误伤含 ".." 的合法文件名。
  it("rejects install when target_path has a parent-segment (..) traversal — exit 7 ARTIFACT_PATH_INVALID", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-traversal-"));
    const zip = new AdmZip();
    zip.addFile("evil.md", Buffer.from("# evil\n"));
    zip.addFile("hunter-skill.json", Buffer.from(JSON.stringify({
      schema_version: 1, slug: "harness-sync", version: "1.0.0", agent: "claude-code",
      target_path: "../evil.md"
    })));
    const artifact = zip.toBuffer();
    const fetch = vi.fn(async () => new Response(artifact, {
      status: 200, headers: { "x-content-sha256": sha256Bytes(artifact) }
    }));
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync", "--agent", "claude-code",
      "--server-url", "https://harness.example", "--token-env", "HH_SKILL_TOKEN"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined });
    expect(exitCode).toBe(7);
  });

  it("accepts install when target_path has a literal '..' inside a filename (not a parent segment)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-dotdot-name-"));
    const zip = new AdmZip();
    zip.addFile("notes..v1.md", Buffer.from("# notes\n"));
    zip.addFile("hunter-skill.json", Buffer.from(JSON.stringify({
      schema_version: 1, slug: "harness-sync", version: "1.0.0", agent: "claude-code",
      target_path: "notes..v1.md"
    })));
    const artifact = zip.toBuffer();
    const fetch = vi.fn(async () => new Response(artifact, {
      status: 200, headers: { "x-content-sha256": sha256Bytes(artifact) }
    }));
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync", "--agent", "claude-code",
      "--server-url", "https://harness.example", "--token-env", "HH_SKILL_TOKEN"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined });
    expect(exitCode).toBe(0);
    expect(await readFile(join(cwd, "notes..v1.md"), "utf8")).toBe("# notes\n");
  });
});
