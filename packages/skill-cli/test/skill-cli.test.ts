import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AdmZip from "adm-zip";
import { canonicalJson } from "@hunter-harness/contracts";
import { sha256Bytes } from "@hunter-harness/core";
import { describe, expect, it, vi } from "vitest";

import { runSkillCli } from "../src/bin.js";

const tokenEnv = { HH_SKILL_TOKEN: "test-token" };

// 与 server buildArtifactFor / core computeSourceHash 同算法：sorted by path → canonicalJson → sha256。
function sourceHashOf(files: Array<{ path: string; content: string }>): string {
  return sha256Bytes(canonicalJson(
    [...files].sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({ path: f.path, content: f.content }))
  ));
}

const DEFAULT_SKILL_CONTENT = "---\nname: harness-sync\ndescription: sync skill\n---\n# harness-sync\n";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function v3Extract(files: Record<string, string>, version: string) {
  return async (_tarball: Buffer, destination: string): Promise<void> => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(destination, path, ".."), { recursive: true });
      await writeFile(join(destination, path), content);
    }
    // npm always supplies this envelope; the installer must ignore it.
    await writeFile(join(destination, "package.json"), JSON.stringify({ name: "@hunter-skills/harness-sync", version }));
    await writeFile(join(destination, "hunter-harness.skill.json"), JSON.stringify({
      schema_version: 3,
      slug: "harness-sync",
      version,
      files: Object.entries(files).map(([path, content]) => ({
        path, sha256: sha256Bytes(content), size: Buffer.byteLength(content)
      })),
      components: [{ role: "skill", source: "." }],
      variants: Object.fromEntries(["claude-code", "codex", "cursor", "codebuddy"].map((agent) => [agent, {
        status: "ready", adapterVersion: "1.0.0", buildHash: null, components: ["skill:."]
      }]))
    }));
  };
}

// folder zip fixture（claude-code 新模型）：多文件 SKILL.md + references/，target_path=文件夹根，install_mode=folder。
// source_sha256 与 server buildArtifactFor 同算法；references/ 一起落地验证多文件 skill 安装修复。
function zipBytes(skillContent = DEFAULT_SKILL_CONTENT): Buffer {
  const guide = "# guide\n";
  const files = [
    { path: "SKILL.md", content: skillContent },
    { path: "references/guide.md", content: guide }
  ];
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(skillContent));
  zip.addFile("references/guide.md", Buffer.from(guide));
  zip.addFile("hunter-skill.json", Buffer.from(JSON.stringify({
    schema_version: 2,
    slug: "harness-sync",
    version: "1.0.0",
    agent: "claude-code",
    source_sha256: sourceHashOf(files),
    target_path: ".claude/skills/harness-sync/",
    install_mode: "folder"
  })));
  return zip.toBuffer();
}

// 簇B cursor fixture：zip 内文件名 harness-sync.mdc（非 SKILL.md），target_path=.cursor/rules/<slug>.mdc，
// 对齐 server buildArtifacts 的 cursor 产出。schema_version=2 + source_sha256 + install_mode=file 对齐 server MANIFEST_SCHEMA_VERSION。
function zipBytesCursor(content = "# harness-sync\n"): Buffer {
  const files = [{ path: "harness-sync.mdc", content }];
  const zip = new AdmZip();
  zip.addFile("harness-sync.mdc", Buffer.from(content));
  zip.addFile("hunter-skill.json", Buffer.from(JSON.stringify({
    schema_version: 2,
    slug: "harness-sync",
    version: "1.0.0",
    agent: "cursor",
    source_sha256: sourceHashOf(files),
    target_path: ".cursor/rules/harness-sync.mdc",
    install_mode: "file"
  })));
  return zip.toBuffer();
}

// draft 端点 mock 响应（CLI runUpload 只取 slug/agent/draftVersion/revision，其余字段仅占位以贴近真实 DraftState）
function draftResponse(slug: string, agent: string, revision = 1, draftVersion = "0.1.0"): Response {
  return Response.json({
    slug, agent, draftVersion, revision,
    sourceFiles: [], ir: { name: slug }, examples: [],
    checks: null, aiChecks: null, releaseNote: null,
    created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z"
  }, { status: 201 });
}

// 解析 multipart FormData：验证文件数 + filename（相对路径，server part.filename 取此）+ filename↔content 精确对应。
// getAll 返回 Blob[]（不带 name），无法按 filename 取 content；故序列化整个 form 为 multipart 文本，
// 按 boundary 分块解析 filename→content 映射，避免依赖 part 顺序（AdmZip getEntries 顺序与 addFile 不同）。
async function expectUploadParts(
  form: FormData,
  expected: Array<{ filename: string; contentContains: string }>
): Promise<void> {
  const blobs = form.getAll("file") as Blob[];
  expect(blobs).toHaveLength(expected.length);
  const multipartText = await new Response(form).text();
  const boundary = /--([^\r\n]+)/.exec(multipartText)?.[1];
  expect(boundary).toBeDefined();
  const byName = new Map<string, string>();
  for (const block of multipartText.split("--" + (boundary ?? ""))) {
    const fn = /filename="([^"]*)"/.exec(block)?.[1];
    if (fn === undefined) continue;
    const body = block.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
    byName.set(fn, body);
  }
  for (const e of expected) {
    expect(byName.has(e.filename)).toBe(true);
    expect(byName.get(e.filename) ?? "").toContain(e.contentContains);
  }
}

// 写一个 claude-code enabled 的 skill.yaml 源目录（upload fixture）
async function writeSkillSource(source: string, name = "harness-candidate"): Promise<void> {
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "skill.yaml"), [
    `name: ${name}`,
    "kind: tooling",
    `description: ${name} skill`,
    `triggers: [${name}]`,
    "inputs: []",
    "outputs: [report]",
    "forbidden_actions: [automatic_git_write]",
    "required_context: [AGENTS.md]",
    "profiles: { general: { enabled: true } }",
    "adapters: { claude-code: { enabled: true } }",
    "version: 1.0.0"
  ].join("\n"));
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
      .toBe(DEFAULT_SKILL_CONTENT);
    // folder 模式：references/ 一起落地（多文件 skill 安装修复核心断言）
    expect(await readFile(join(cwd, ".claude/skills/harness-sync/references/guide.md"), "utf8"))
      .toBe("# guide\n");

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

  it("U-12 install accepts slug 'my-skill' without harness- prefix", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-install-newslug-"));
    const fetch = vi.fn(async () => new Response(zipBytes(), {
      status: 200,
      headers: { "x-content-sha256": sha256Bytes(zipBytes()) }
    }));
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "my-skill", "--agent", "claude-code",
      "--server-url", "https://harness.example", "--token-env", "HH_SKILL_TOKEN"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined });
    // my-skill 应通过 slug 校验，fetch 应被调用（exit code 不应为 3/SKILL_SLUG_INVALID）
    expect(exitCode).not.toBe(3);
    expect(fetch).toHaveBeenCalled();
  });

  it("U-13 install rejects slug '-x' with exit 3 (SKILL_SLUG_INVALID)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-install-badslug-"));
    const fetch = vi.fn(async () => { throw new Error("should not be called"); });
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "-x", "--agent", "claude-code",
      "--server-url", "https://harness.example", "--token-env", "HH_SKILL_TOKEN"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined });
    expect(exitCode).toBe(3);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uploads a directory to the per-agent draft endpoint as multipart (INT-102)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-upload-"));
    const source = join(cwd, "candidate");
    await writeSkillSource(source);
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const url = String(input);
      expect(url).toContain("/api/v1/skills/draft");
      expect(url).toContain("agent=claude-code");
      expect(init?.body).toBeInstanceOf(FormData);
      await expectUploadParts(init?.body as FormData, [
        { filename: "skill.yaml", contentContains: "name: harness-candidate" }
      ]);
      return draftResponse("harness-candidate", "claude-code");
    });
    const output: string[] = [];
    expect(await runSkillCli([
      "node", "skill-cli", "upload", source,
      "--agent", "claude-code", "--server-url", "https://harness.example",
      "--token-env", "HH_SKILL_TOKEN", "--json"
    ], { cwd, env: tokenEnv, fetch, stdout: (v) => output.push(v), stderr: () => undefined })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const result = JSON.parse(output.join(""));
    expect(result).toMatchObject({
      ok: true, action: "draft-created",
      slug: "harness-candidate", agent: "claude-code",
      draftVersion: "0.1.0", revision: 1
    });

    // D2：本期不加 CLI publish 子命令（留给 Web 或后续切片）
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
      join(cwd, ".harness", "state", "local", "skill-installs", "cursor", "harness-sync.json"), "utf8"
    ));
    expect(manifest.agent).toBe("cursor");
    expect(manifest.files).toHaveProperty("harness-sync.mdc");
  });

  it("installs a legacy single-file artifact with source_ir_sha256 manifest (backward compat)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-legacy-"));
    const skill = "# harness-legacy\n";
    const files = [{ path: "SKILL.md", content: skill }];
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from(skill));
    // 旧 manifest：schema_version 1 + source_ir_sha256（无 source_sha256 / install_mode），target_path=完整文件路径
    zip.addFile("hunter-skill.json", Buffer.from(JSON.stringify({
      schema_version: 1,
      slug: "harness-sync",
      version: "1.0.0",
      agent: "claude-code",
      source_ir_sha256: sourceHashOf(files),
      target_path: ".claude/skills/harness-sync/SKILL.md"
    })));
    const artifact = zip.toBuffer();
    const fetch = vi.fn(async () => new Response(artifact, {
      status: 200,
      headers: { "x-content-sha256": sha256Bytes(artifact) }
    }));
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync", "--agent", "claude-code",
      "--server-url", "https://harness.example", "--token-env", "HH_SKILL_TOKEN"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined });
    expect(exitCode).toBe(0);
    expect(await readFile(join(cwd, ".claude/skills/harness-sync/SKILL.md"), "utf8")).toBe(skill);
  });

  it("rejects a folder artifact whose source_sha256 does not match the extracted files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-source-mismatch-"));
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from("# tampered\n"));
    zip.addFile("hunter-skill.json", Buffer.from(JSON.stringify({
      schema_version: 2,
      slug: "harness-sync",
      version: "1.0.0",
      agent: "claude-code",
      source_sha256: "sha256:deadbeef",
      target_path: ".claude/skills/harness-sync/",
      install_mode: "folder"
    })));
    const artifact = zip.toBuffer();
    const fetch = vi.fn(async () => new Response(artifact, {
      status: 200,
      headers: { "x-content-sha256": sha256Bytes(artifact) }
    }));
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync", "--agent", "claude-code",
      "--server-url", "https://harness.example", "--token-env", "HH_SKILL_TOKEN"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined });
    expect(exitCode).toBe(7);
    expect(await pathExists(join(cwd, ".claude", "skills", "harness-sync", "SKILL.md"))).toBe(false);
  });

  it("uploads with agent=cursor to the per-agent draft endpoint (INT-103)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-cursor-upload-"));
    const source = join(cwd, "candidate");
    await mkdir(source, { recursive: true });
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
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const url = String(input);
      expect(url).toContain("/api/v1/skills/draft");
      expect(url).toContain("agent=cursor");
      expect(init?.body).toBeInstanceOf(FormData);
      await expectUploadParts(init?.body as FormData, [
        { filename: "skill.yaml", contentContains: "name: harness-candidate" }
      ]);
      return draftResponse("harness-candidate", "cursor");
    });
    expect(await runSkillCli([
      "node", "skill-cli", "upload", source,
      "--agent", "cursor", "--server-url", "https://harness.example",
      "--token-env", "HH_SKILL_TOKEN", "--json"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uploads with agent=codex to the draft endpoint (UT-003 upload 白名单扩展)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-codex-upload-"));
    const source = join(cwd, "candidate");
    await writeSkillSource(source);
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toContain("agent=codex");
      expect(init?.body).toBeInstanceOf(FormData);
      return draftResponse("harness-candidate", "codex");
    });
    expect(await runSkillCli([
      "node", "skill-cli", "upload", source,
      "--agent", "codex", "--server-url", "https://harness.example",
      "--token-env", "HH_SKILL_TOKEN", "--json"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uploads with agent=codebuddy to the draft endpoint (UT-004 upload allowlist)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-codebuddy-upload-"));
    const source = join(cwd, "candidate");
    await writeSkillSource(source);
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toContain("agent=codebuddy");
      expect(init?.body).toBeInstanceOf(FormData);
      return draftResponse("harness-candidate", "codebuddy");
    });
    expect(await runSkillCli([
      "node", "skill-cli", "upload", source,
      "--agent", "codebuddy", "--server-url", "https://harness.example",
      "--token-env", "HH_SKILL_TOKEN", "--json"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects upload with unsupported agent (mcp) ADAPTER_UNSUPPORTED exit 3 without calling server (UT-005)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-mcp-upload-"));
    const source = join(cwd, "candidate");
    await writeSkillSource(source);
    const fetch = vi.fn();
    const exitCode = await runSkillCli([
      "node", "skill-cli", "upload", source,
      "--agent", "mcp", "--server-url", "https://harness.example",
      "--token-env", "HH_SKILL_TOKEN"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined });
    expect(exitCode).toBe(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uploads a ZIP source unpacked as multipart file parts preserving relative paths (UT-011)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-zip-upload-"));
    const zip = new AdmZip();
    zip.addFile("skill.yaml", Buffer.from("name: harness-zipped\nkind: tooling\n"));
    zip.addFile("references/guide.md", Buffer.from("# guide\n"));
    const source = join(cwd, "skill.zip");
    await writeFile(source, zip.toBuffer());
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      await expectUploadParts(init?.body as FormData, [
        { filename: "skill.yaml", contentContains: "name: harness-zipped" },
        { filename: "references/guide.md", contentContains: "# guide" }
      ]);
      return draftResponse("harness-zipped", "claude-code");
    });
    expect(await runSkillCli([
      "node", "skill-cli", "upload", source,
      "--agent", "claude-code", "--server-url", "https://harness.example",
      "--token-env", "HH_SKILL_TOKEN", "--json"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined })).toBe(0);
  });

  it("uploads a directory with nested files preserving relative paths (UT-010 目录递归)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-dir-nested-"));
    const source = join(cwd, "candidate");
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(join(source, "skill.yaml"), "name: harness-nested\nkind: tooling\n");
    await writeFile(join(source, "references", "guide.md"), "# nested guide\n");
    const fetch = vi.fn(async () => draftResponse("harness-nested", "claude-code"));
    expect(await runSkillCli([
      "node", "skill-cli", "upload", source,
      "--agent", "claude-code", "--server-url", "https://harness.example",
      "--token-env", "HH_SKILL_TOKEN", "--json"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: () => undefined })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as [string | URL, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    await expectUploadParts(init.body as FormData, [
      { filename: "skill.yaml", contentContains: "name: harness-nested" },
      { filename: "references/guide.md", contentContains: "# nested guide" }
    ]);
  });

  it("propagates server SENSITIVE_CONTENT_BLOCKED as CliFailure exit 4 (UT-021)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-sensitive-"));
    const source = join(cwd, "candidate");
    await writeSkillSource(source);
    const fetch = vi.fn(async () => Response.json(
      { error: { code: "SENSITIVE_CONTENT_BLOCKED", message: "skill contains sensitive content" } },
      { status: 422 }
    ));
    const stderr: string[] = [];
    const exitCode = await runSkillCli([
      "node", "skill-cli", "upload", source,
      "--agent", "claude-code", "--server-url", "https://harness.example",
      "--token-env", "HH_SKILL_TOKEN"
    ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: (v) => stderr.push(v) });
    expect(exitCode).toBe(4);
    expect(stderr.join("")).toContain("SENSITIVE_CONTENT_BLOCKED");
  });

  it("propagates server SKILL_VALIDATION_FAILED and WORKFLOW_PACKAGE_REDIRECT as exit 4 (UT-022/023)", async () => {
    for (const code of ["SKILL_VALIDATION_FAILED", "WORKFLOW_PACKAGE_REDIRECT"] as const) {
      const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-" + code.toLowerCase() + "-"));
      const source = join(cwd, "candidate");
      await writeSkillSource(source);
      const fetch = vi.fn(async () => Response.json(
        { error: { code, message: code } },
        { status: 422 }
      ));
      const stderr: string[] = [];
      const exitCode = await runSkillCli([
        "node", "skill-cli", "upload", source,
        "--agent", "claude-code", "--server-url", "https://harness.example",
        "--token-env", "HH_SKILL_TOKEN"
      ], { cwd, env: tokenEnv, fetch, stdout: () => undefined, stderr: (v) => stderr.push(v) });
      expect(exitCode).toBe(4);
      expect(stderr.join("")).toContain(code);
    }
  });

  it("rejects install with unsupported agent (mcp) ADAPTER_UNSUPPORTED exit 3", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-mcp-"));
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync", "--agent", "mcp",
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

  it("installs from npm with injected pacote extract fixture", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-npm-install-"));
    const skillContent = DEFAULT_SKILL_CONTENT;
    const guide = "# guide\n";
    const files = [
      { path: "SKILL.md", content: skillContent },
      { path: "references/guide.md", content: guide }
    ];
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync", "--agent", "claude-code",
      "--from", "npm", "--npm-scope", "@hunter-skills"
    ], {
      cwd,
      env: { ...tokenEnv, HUNTER_HARNESS_NPM_SCOPE: "@hunter-skills" },
      pacoteTarball: async () => zipBytes(skillContent),
      extractNpmTarball: async (_tarball, destination) => {
        await mkdir(join(destination, "references"), { recursive: true });
        await writeFile(join(destination, "SKILL.md"), skillContent, "utf8");
        await writeFile(join(destination, "references", "guide.md"), guide, "utf8");
        await writeFile(join(destination, "hunter-skill.json"), JSON.stringify({
          schema_version: 2,
          slug: "harness-sync",
          version: "1.0.0",
          agent: "claude-code",
          source_sha256: sourceHashOf(files),
          target_path: ".claude/skills/harness-sync/",
          install_mode: "folder"
        }), "utf8");
      },
      stdout: () => undefined,
      stderr: () => undefined
    });
    expect(exitCode).toBe(0);
    expect(await readFile(join(cwd, ".claude", "skills", "harness-sync", "SKILL.md"), "utf8")).toBe(skillContent);
  });

  it("downloads an npm package once and extracts the exact downloaded bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-npm-single-fetch-"));
    const packageBytes = Buffer.from("single-fetch-package");
    const pacoteTarball = vi.fn(async () => packageBytes);
    const extractNpmTarball = vi.fn(async (received: Buffer, destination: string) => {
      await writeFile(join(destination, "SKILL.md"), DEFAULT_SKILL_CONTENT, "utf8");
      await writeFile(join(destination, "hunter-harness.skill.json"), JSON.stringify({
        schema_version: 3,
        slug: "harness-sync",
        version: "2.0.0",
        files: [{
          path: "SKILL.md",
          sha256: sha256Bytes(DEFAULT_SKILL_CONTENT),
          size: Buffer.byteLength(DEFAULT_SKILL_CONTENT)
        }],
        components: [{ role: "skill", source: "." }],
        variants: Object.fromEntries(["claude-code", "codex", "cursor", "codebuddy"].map((agent) => [agent, {
          status: "ready", adapterVersion: "1.0.0", buildHash: null, components: ["skill:."]
        }]))
      }), "utf8");
      expect(received).toBe(packageBytes);
    });

    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync", "--agent", "codex",
      "--scope", "project", "--project", cwd, "--from", "npm",
      "--npm-scope", "@hunter-skills", "--yes"
    ], {
      cwd,
      env: tokenEnv,
      pacoteTarball,
      extractNpmTarball,
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(exitCode).toBe(0);
    expect(pacoteTarball).toHaveBeenCalledTimes(1);
    expect(extractNpmTarball).toHaveBeenCalledTimes(1);
    expect(await readFile(join(cwd, ".agents", "skills", "harness-sync", "SKILL.md"), "utf8"))
      .toBe(DEFAULT_SKILL_CONTENT);
  });

  it("installs one v3 package for multiple agents with nested resources and native subagents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-v3-project-"));
    const files = {
      "SKILL.md": DEFAULT_SKILL_CONTENT,
      "references/guide.md": "# guide\n",
      "scripts/check.ts": "console.log('check');\n",
      "subagents/reviewer.md": "# reviewer\n",
      "subagents/reviewer.toml": "name = \"reviewer\"\n"
    };
    const output: string[] = [];
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync",
      "--agent", "claude-code", "--agent", "codex",
      "--scope", "project", "--project", cwd,
      "--from", "npm", "--npm-scope", "@hunter-skills", "--yes", "--json"
    ], {
      cwd,
      env: tokenEnv,
      pacoteTarball: async () => Buffer.from("v3-package"),
      extractNpmTarball: async (_tarball, destination) => {
        for (const [path, content] of Object.entries(files)) {
          await mkdir(join(destination, path, ".."), { recursive: true });
          await writeFile(join(destination, path), content, "utf8");
        }
        await writeFile(join(destination, "hunter-skill.json"), JSON.stringify({
          schema_version: 3,
          slug: "harness-sync",
          version: "2.0.0",
          files: Object.entries(files).map(([path, content]) => ({
            path, sha256: sha256Bytes(content), size: Buffer.byteLength(content)
          })),
          components: [
            { role: "skill", source: "." },
            {
              role: "subagent", source: ".", name: "reviewer",
              variants: {
                "claude-code": "subagents/reviewer.md",
                codex: "subagents/reviewer.toml",
                cursor: "subagents/reviewer.md",
                codebuddy: "subagents/reviewer.md"
              }
            }
          ],
          variants: Object.fromEntries(["claude-code", "codex", "cursor", "codebuddy"].map((agent) => [agent, {
            status: "ready", adapterVersion: "1.0.0", buildHash: null, components: ["skill", "subagent:reviewer"]
          }]))
        }), "utf8");
      },
      stdout: (value) => output.push(value),
      stderr: () => undefined
    });

    expect(exitCode).toBe(0);
    expect(await readFile(join(cwd, ".claude/skills/harness-sync/references/guide.md"), "utf8")).toBe("# guide\n");
    expect(await readFile(join(cwd, ".agents/skills/harness-sync/scripts/check.ts"), "utf8")).toContain("console.log");
    expect(await readFile(join(cwd, ".claude/agents/reviewer.md"), "utf8")).toBe("# reviewer\n");
    expect(await readFile(join(cwd, ".codex/agents/reviewer.toml"), "utf8")).toContain("name =");
    expect(await pathExists(join(cwd, ".agents/skills/harness-sync/subagents/reviewer.toml"))).toBe(false);
    expect(await pathExists(join(cwd, ".harness/state/local/skill-installs/claude-code/harness-sync.json"))).toBe(true);
    expect(await pathExists(join(cwd, ".harness/state/local/skill-installs/codex/harness-sync.json"))).toBe(true);
    expect(output.join("")) .toContain("install-preview");
  });

  it("migrates a uniquely identified slug-only project install state during a v3 update", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-v3-legacy-state-"));
    const installedSkill = join(cwd, ".claude", "skills", "harness-sync", "SKILL.md");
    await mkdir(join(installedSkill, ".."), { recursive: true });
    await writeFile(installedSkill, DEFAULT_SKILL_CONTENT, "utf8");
    const legacyState = join(cwd, ".harness", "state", "local", "skill-installs", "harness-sync.json");
    await mkdir(join(legacyState, ".."), { recursive: true });
    await writeFile(legacyState, JSON.stringify({
      schema_version: 1,
      slug: "harness-sync",
      version: "1.0.0",
      agent: "claude-code",
      source_url: "npm:@hunter-skills/harness-sync",
      artifact_sha256: "sha256:legacy-artifact",
      files: { "SKILL.md": sha256Bytes(DEFAULT_SKILL_CONTENT) },
      installed_at: "2026-07-01T00:00:00.000Z"
    }), "utf8");

    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync",
      "--agent", "claude-code", "--scope", "project", "--project", cwd,
      "--from", "npm", "--npm-scope", "@hunter-skills", "--yes"
    ], {
      cwd,
      env: tokenEnv,
      pacoteTarball: async () => Buffer.from("v3-legacy-migration-package"),
      extractNpmTarball: async (_tarball, destination) => {
        await writeFile(join(destination, "SKILL.md"), DEFAULT_SKILL_CONTENT, "utf8");
        await writeFile(join(destination, "hunter-skill.json"), JSON.stringify({
          schema_version: 3,
          slug: "harness-sync",
          version: "2.0.0",
          files: [{
            path: "SKILL.md",
            sha256: sha256Bytes(DEFAULT_SKILL_CONTENT),
            size: Buffer.byteLength(DEFAULT_SKILL_CONTENT)
          }],
          components: [{ role: "skill", source: "." }],
          variants: Object.fromEntries(["claude-code", "codex", "cursor", "codebuddy"].map((agent) => [agent, {
            status: "ready", adapterVersion: "1.0.0", buildHash: null, components: ["skill"]
          }]))
        }), "utf8");
      },
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(exitCode).toBe(0);
    const migratedState = JSON.parse(await readFile(
      join(cwd, ".harness", "state", "local", "skill-installs", "claude-code", "harness-sync.json"),
      "utf8"
    )) as { schema_version: number; agent: string; scope: string };
    expect(migratedState).toMatchObject({ schema_version: 2, agent: "claude-code", scope: "project" });
    expect(await pathExists(legacyState)).toBe(true);
  });

  it("installs cursor and codebuddy v3 variants into the current-user scope", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-v3-cwd-"));
    const userHome = await mkdtemp(join(tmpdir(), "hunter-skill-v3-home-"));
    const files = { "SKILL.md": DEFAULT_SKILL_CONTENT, "subagents/reviewer.md": "# reviewer\n" };
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync",
      "--agent", "cursor", "--agent", "codebuddy", "--scope", "user",
      "--from", "npm", "--npm-scope", "@hunter-skills", "--yes"
    ], {
      cwd, userHome, env: tokenEnv,
      pacoteTarball: async () => Buffer.from("v3-user-package"),
      extractNpmTarball: async (_tarball, destination) => {
        await mkdir(join(destination, "subagents"), { recursive: true });
        for (const [path, content] of Object.entries(files)) await writeFile(join(destination, path), content);
        await writeFile(join(destination, "hunter-skill.json"), JSON.stringify({
          schema_version: 3, slug: "harness-sync", version: "2.0.0",
          files: Object.entries(files).map(([path, content]) => ({ path, sha256: sha256Bytes(content), size: Buffer.byteLength(content) })),
          components: [
            { role: "skill", source: "." },
            { role: "subagent", source: ".", name: "reviewer", variants: {
              "claude-code": "subagents/reviewer.md", codex: "subagents/reviewer.toml",
              cursor: "subagents/reviewer.md", codebuddy: "subagents/reviewer.md"
            } }
          ],
          variants: Object.fromEntries(["claude-code", "codex", "cursor", "codebuddy"].map((agent) => [agent, {
            status: agent === "codex" ? "degraded" : "ready", adapterVersion: "1.0.0", buildHash: null, components: ["skill"]
          }]))
        }));
      },
      stdout: () => undefined, stderr: () => undefined
    });

    expect(exitCode).toBe(0);
    expect(await pathExists(join(userHome, ".cursor/skills/harness-sync/SKILL.md"))).toBe(true);
    expect(await pathExists(join(userHome, ".codebuddy/skills/harness-sync/SKILL.md"))).toBe(true);
    expect(await pathExists(join(userHome, ".cursor/agents/reviewer.md"))).toBe(true);
    expect(await pathExists(join(userHome, ".codebuddy/agents/reviewer.md"))).toBe(true);
    expect(await pathExists(join(userHome, ".hunter-harness/state/skill-installs/cursor/harness-sync.json"))).toBe(true);
  });

  it("prompts for agents, scope and confirmation when install choices are omitted in a TTY", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-v3-prompt-"));
    const answers = ["claude-code,codex", "project", "y"];
    const questions: string[] = [];
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync", "--from", "npm", "--npm-scope", "@hunter-skills"
    ], {
      cwd, env: tokenEnv, isTTY: true,
      prompt: async (question) => { questions.push(question); return answers.shift() ?? ""; },
      pacoteTarball: async () => Buffer.from("v3-prompt-package"),
      extractNpmTarball: async (_tarball, destination) => {
        await writeFile(join(destination, "SKILL.md"), DEFAULT_SKILL_CONTENT);
        await writeFile(join(destination, "hunter-skill.json"), JSON.stringify({
          schema_version: 3, slug: "harness-sync", version: "2.0.0",
          files: [{ path: "SKILL.md", sha256: sha256Bytes(DEFAULT_SKILL_CONTENT), size: Buffer.byteLength(DEFAULT_SKILL_CONTENT) }],
          components: [{ role: "skill", source: "." }],
          variants: Object.fromEntries(["claude-code", "codex", "cursor", "codebuddy"].map((agent) => [agent, {
            status: "ready", adapterVersion: "1.0.0", buildHash: null, components: ["skill"]
          }]))
        }));
      },
      stdout: () => undefined, stderr: () => undefined
    });
    expect(exitCode).toBe(0);
    expect(questions).toHaveLength(3);
    expect(await pathExists(join(cwd, ".agents/skills/harness-sync/SKILL.md"))).toBe(true);
  });

  it("removes files managed by the previous v3 installation when an update drops them", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-v3-update-"));
    const args = ["node", "skill-cli", "install", "harness-sync", "--agent", "codex", "--scope", "project",
      "--project", cwd, "--from", "npm", "--npm-scope", "@hunter-skills", "--yes"];
    const firstFiles = { "SKILL.md": DEFAULT_SKILL_CONTENT, "scripts/obsolete.ts": "export {};\n" };
    expect(await runSkillCli(args, {
      cwd, env: tokenEnv, pacoteTarball: async () => Buffer.from("v3-first"),
      extractNpmTarball: v3Extract(firstFiles, "2.0.0"), stdout: () => undefined, stderr: () => undefined
    })).toBe(0);
    const obsolete = join(cwd, ".agents/skills/harness-sync/scripts/obsolete.ts");
    expect(await pathExists(obsolete)).toBe(true);

    expect(await runSkillCli(args, {
      cwd, env: tokenEnv, pacoteTarball: async () => Buffer.from("v3-second"),
      extractNpmTarball: v3Extract({ "SKILL.md": DEFAULT_SKILL_CONTENT }, "2.0.1"),
      stdout: () => undefined, stderr: () => undefined
    })).toBe(0);
    expect(await pathExists(obsolete)).toBe(false);
  });

  it("rejects a v3 install path that traverses an existing junction or symlink", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hunter-skill-v3-link-"));
    const outside = await mkdtemp(join(tmpdir(), "hunter-skill-v3-outside-"));
    await mkdir(join(cwd, ".agents", "skills"), { recursive: true });
    await symlink(outside, join(cwd, ".agents", "skills", "harness-sync"), process.platform === "win32" ? "junction" : "dir");
    const exitCode = await runSkillCli([
      "node", "skill-cli", "install", "harness-sync", "--agent", "codex", "--scope", "project",
      "--project", cwd, "--from", "npm", "--npm-scope", "@hunter-skills", "--yes", "--force"
    ], {
      cwd, env: tokenEnv, pacoteTarball: async () => Buffer.from("v3-link"),
      extractNpmTarball: v3Extract({ "SKILL.md": DEFAULT_SKILL_CONTENT }, "2.0.0"),
      stdout: () => undefined, stderr: () => undefined
    });
    expect(exitCode).toBe(7);
    expect(await pathExists(join(outside, "SKILL.md"))).toBe(false);
  });
});
