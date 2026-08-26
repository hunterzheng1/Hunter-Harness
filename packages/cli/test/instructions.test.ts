import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Bytes } from "@hunter-harness/core";

import { runCli } from "../src/bin.js";
import { recoveryEnv } from "./recovery-env.js";

const resourcesRoot = fileURLToPath(
  new URL("../../workflow-data-harness", import.meta.url)
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("hunter-harness instructions", () => {
  let root: string;
  let originalAgents: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-instructions-"));
    expect(await runCli(["--profile", "general", "--non-interactive", "--yes"], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined,
      env: { ...recoveryEnv }
    })).toBe(0);
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "server_url: https://platform.example.test\ntoken: instructions-token\nproject_id: prj_instructions\n",
      "utf8"
    );
    originalAgents = await readFile(join(root, "AGENTS.md"), "utf8");
  });

  function proposalFetch(content: string, proposalId = "ipr_contract") {
    return vi.fn(async () => json({
      schema_version: 1,
      proposal_id: proposalId,
      project_id: "prj_instructions",
      language: "zh-CN",
      mode: "audit-propose",
      applied: false,
      generated_at: "2026-08-08T00:00:00.000Z",
      findings: [{
        code: "LEGACY_MANAGED_BLOCK",
        severity: "info",
        path: "AGENTS.md",
        message: "根指令文档需要迁移为无标记全文"
      }],
      files: [{
        path: "AGENTS.md",
        operation: "modify",
        base_content_sha256: sha256Bytes(originalAgents),
        content_sha256: sha256Bytes(content),
        content
      }],
      rule_candidates: [{
        candidate_id: "rc_0000000000000001",
        content: "协议变更必须包含迁移",
        evidence: [{
          change_key: "change-contract",
          summary: "协议改动包含迁移步骤"
        }],
        evidence_count: 1,
        auto_apply: false,
        recommendation: "review"
      }],
      basis: ["https://agents.md/"],
      request_id: "00000000-0000-7000-8000-000000000001"
    }, 201));
  }

  it("keeps audit read-only, then applies the reviewed proposal transactionally", async () => {
    const proposed = "# 项目协作指南\n\n## 验证要求\n\n- 修改后运行相关测试。\n";
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["instructions", "audit", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: proposalFetch(proposed) as unknown as typeof globalThis.fetch,
      env: { ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(code, stderr.join("\n")).toBe(0);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(originalAgents);
    const audit = JSON.parse(stdout.join("")) as { proposal_path: string };

    const applyOutput: string[] = [];
    expect(await runCli([
      "instructions", "apply", "--proposal", audit.proposal_path, "--yes", "--json"
    ], {
      cwd: root,
      resourcesRoot,
      env: { ...recoveryEnv },
      stdout: (value) => applyOutput.push(value),
      stderr: (value) => stderr.push(value)
    })).toBe(0);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(proposed);
    expect(proposed).not.toContain("hunter-harness:start");
    expect(JSON.parse(applyOutput.join(""))).toMatchObject({
      applied: true,
      rule_candidates_applied: false
    });
  });

  it("refuses to overwrite a document changed after audit", async () => {
    const proposed = "# 新提案\n";
    const stdout: string[] = [];
    await runCli(["instructions", "audit", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: proposalFetch(proposed) as unknown as typeof globalThis.fetch,
      env: { ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: () => undefined
    });
    const audit = JSON.parse(stdout.join("")) as { proposal_path: string };
    await writeFile(join(root, "AGENTS.md"), "# 用户的新修改\n", "utf8");
    const applyOutput: string[] = [];
    const code = await runCli([
      "instructions", "apply", "--proposal", audit.proposal_path, "--yes", "--json"
    ], {
      cwd: root,
      resourcesRoot,
      env: { ...recoveryEnv },
      stdout: (value) => applyOutput.push(value),
      stderr: () => undefined
    });
    expect(code).toBe(4);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# 用户的新修改\n");
    expect(JSON.parse(applyOutput.join(""))).toMatchObject({
      ok: false,
      errors: [{ code: "INSTRUCTION_PROPOSAL_STALE" }]
    });
  });

  it("rejects a traversal proposal id without overwriting project files", async () => {
    const sentinel = "{\"name\":\"keep-project-package\"}\n";
    await writeFile(join(root, "package.json"), sentinel, "utf8");
    const stderr: string[] = [];

    const code = await runCli(["instructions", "audit", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: proposalFetch(
        "# 恶意提案\n",
        "ipr_/../../../../../package"
      ) as unknown as typeof globalThis.fetch,
      env: { ...recoveryEnv },
      stdout: () => undefined,
      stderr: (value) => stderr.push(value)
    });

    expect(code, stderr.join("\n")).not.toBe(0);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(sentinel);
  });
});
