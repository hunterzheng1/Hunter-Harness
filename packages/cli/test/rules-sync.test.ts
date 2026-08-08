import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Bytes } from "@hunter-harness/core";
import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("hunter-harness rules-sync compatibility CLI", () => {
  it("generates a remote Chinese proposal without changing project documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-rules-sync-cli-"));
    expect(await runCli(["--profile", "general", "--non-interactive", "--yes"], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined,
      env: {}
    })).toBe(0);
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "server_url: https://platform.example.test\ntoken: rules-token\nproject_id: prj_rules\n",
      "utf8"
    );
    const original = await readFile(join(root, "AGENTS.md"), "utf8");
    const proposed = "# 项目协作指南\n\n- 修改后运行相关测试。\n";
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      schema_version: 1,
      proposal_id: "ipr_rules",
      project_id: "prj_rules",
      language: "zh-CN",
      mode: "audit-propose",
      applied: false,
      generated_at: "2026-08-08T00:00:00.000Z",
      findings: [{
        code: "DOCUMENT_CAN_BE_IMPROVED",
        severity: "info",
        path: "AGENTS.md",
        message: "可按项目结构补充验证约定"
      }],
      files: [{
        path: "AGENTS.md",
        operation: "modify",
        base_content_sha256: sha256Bytes(original),
        content_sha256: sha256Bytes(proposed),
        content: proposed
      }],
      rule_candidates: [{
        candidate_id: "rc_0000000000000002",
        content: "协议变更应提供迁移方案",
        evidence: [{
          change_key: "change-rules",
          summary: "协议调整包含迁移方案"
        }],
        evidence_count: 1,
        auto_apply: false,
        recommendation: "review"
      }],
      basis: ["https://agents.md/"],
      request_id: "00000000-0000-7000-8000-000000000002"
    }), {
      status: 201,
      headers: { "content-type": "application/json" }
    }));
    const stdout: string[] = [];
    const code = await runCli(["rules-sync", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      env: {}
    });
    const output = JSON.parse(stdout.join("")) as {
      command: string;
      dry_run: boolean;
      summary: { proposal_path: string; applied: number; rule_candidates: number };
      warnings: string[];
    };

    expect(code).toBe(0);
    expect(output.command).toBe("rules-sync");
    expect(output.dry_run).toBe(true);
    expect(output.summary).toMatchObject({ applied: 0, rule_candidates: 1 });
    expect(output.warnings.join("\n")).toContain("不再注入标记块");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(original);
    expect((await stat(output.summary.proposal_path)).isFile()).toBe(true);
  });
});
