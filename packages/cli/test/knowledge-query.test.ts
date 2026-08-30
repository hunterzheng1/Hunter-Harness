import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  knowledgeQueryHttpReceiptId,
  knowledgeQueryHttpResultSetHash
} from "@hunter-harness/contracts";
import { sha256Bytes } from "@hunter-harness/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/bin.js";
import { recoveryEnv } from "./recovery-env.js";
import { seededInit } from "./seeded-init.js";

const resourcesRoot = fileURLToPath(
  new URL("../../workflow-data-harness", import.meta.url)
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("hunter-harness knowledge query", () => {
  let root: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-knowledge-query-"));
    stdout = [];
    stderr = [];
    await seededInit(root, "knowledge-query-general", async (seedRoot) => {
      expect(await runCli(["--profile", "general", "--non-interactive", "--yes"], {
        cwd: seedRoot,
        resourcesRoot,
        stdout: () => undefined,
        stderr: () => undefined,
        env: { ...recoveryEnv }
      })).toBe(0);
    });
    await rm(join(root, ".harness", "knowledge"), { recursive: true, force: true });
    await mkdir(join(root, ".harness"), { recursive: true });
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "server_url: https://platform.example.test\ntoken: knowledge-token\nproject_id: prj_knowledge\n",
      "utf8"
    );
  });

  it("queries only the bounded remote knowledge endpoint and leaves no local index", async () => {
    const query = "原始 ZIP";
    const query_hash = sha256Bytes(query);
    const result = {
      result_id: "result_archive",
      kind: "archive_knowledge" as const,
      summary: "原始 ZIP 保留在服务端。",
      relevance: "high" as const,
      source: ".harness/archive/change/spec/design.md",
      verified_at: "2026-08-13T23:00:00.000Z",
      source_version: "pv_archive",
      conflicts_with_intent: false
    };
    const receiptWithoutId = {
      schema_version: 1 as const,
      query_hash,
      project_id: "prj_knowledge",
      index_generation: "generation-1",
      result_ids: [result.result_id],
      source_versions: [result.source_version],
      result_set_hash: knowledgeQueryHttpResultSetHash({
        index_generation: "generation-1",
        result_ids: [result.result_id],
        source_versions: [result.source_version]
      }),
      status: "succeeded" as const,
      executed_at: "2026-08-14T00:00:00.000Z",
      reason_code: "initial_intent" as const
    };
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; query_id: string };
      expect(body.query).toBe(query);
      expect(body.query_id).toBe(`knowledge_query:${query_hash.slice(7)}`);
      return json({
        schema_version: 1,
        query_id: body.query_id,
        project_id: "prj_knowledge",
        receipt: {
          ...receiptWithoutId,
          receipt_id: knowledgeQueryHttpReceiptId(receiptWithoutId)
        },
        results: [result]
      });
    });

    const code = await runCli([
      "knowledge", "query", query, "--limit", "5", "--json"
    ], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: { ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code, stderr.join("\n")).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "/api/v1/projects/prj_knowledge/knowledge/query"
    );
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      command: "knowledge query",
      source: "remote",
      fallback: false,
      count: 1,
      query_id: `knowledge_query:${query_hash.slice(7)}`,
      receipt: {
        receipt_id: knowledgeQueryHttpReceiptId(receiptWithoutId),
        result_set_hash: receiptWithoutId.result_set_hash,
        index_generation: "generation-1"
      },
      items: [{ result_id: "result_archive", summary: "原始 ZIP 保留在服务端。" }]
    });
    await expect(import("node:fs/promises").then(({ stat }) =>
      stat(join(root, ".harness", "knowledge"))
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("knowledge status 返回管道自查（P0-1：查询为空时区分 job 未跑/失败/结果为空）", async () => {
    const fetch = vi.fn(async () => json({
      pending_count: 0,
      pending_capped: false,
      pipeline: {
        project_id: "prj_knowledge",
        generation: 1,
        results_count: 0,
        jobs: { queued: 1, extracting: 0, ready: 0, failed: 0 },
        latest_job_updated_at: "2026-08-30T10:00:00.000Z"
      },
      request_id: "req_status_1"
    }));
    const code = await runCli(["knowledge", "status", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: { ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code, stderr.join("\n")).toBe(0);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "/api/v1/projects/prj_knowledge/knowledge/projection-status"
    );
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      command: "knowledge status",
      ok: true,
      project_id: "prj_knowledge",
      pipeline: {
        generation: 1,
        results_count: 0,
        jobs: { queued: 1, extracting: 0, ready: 0, failed: 0 }
      }
    });
  });

  it("fails closed when the remote service is unavailable", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const code = await runCli(["knowledge", "query", "历史决策", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: { ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code).not.toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      command: "knowledge query",
      ok: false,
      source: "remote",
      fallback: false
    });
  });

  it("surfaces a durable failed receipt without falling back to local or legacy search", async () => {
    const query = "历史决策";
    const query_hash = sha256Bytes(query);
    const receiptWithoutId = {
      schema_version: 1 as const,
      query_hash,
      project_id: "prj_knowledge",
      index_generation: "generation-1",
      result_ids: [] as string[],
      source_versions: [] as string[],
      result_set_hash: knowledgeQueryHttpResultSetHash({
        index_generation: "generation-1",
        result_ids: [],
        source_versions: []
      }),
      status: "failed" as const,
      executed_at: "2026-08-14T00:00:00.000Z",
      reason_code: "remote_knowledge_unavailable" as const,
      failure_code: "BACKEND_SECRET"
    };
    const fetch = vi.fn(async () => json({
      schema_version: 1,
      query_id: `knowledge_query:${query_hash.slice(7)}`,
      project_id: "prj_knowledge",
      receipt: {
        ...receiptWithoutId,
        receipt_id: knowledgeQueryHttpReceiptId(receiptWithoutId)
      },
      results: []
    }));

    const code = await runCli(["knowledge", "query", query, "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: { ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code).toBe(3);
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain("semantic/search");
    const output = JSON.parse(stdout.join("")) as {
      receipt?: Record<string, unknown>;
      [key: string]: unknown;
    };
    expect(output).toMatchObject({
      command: "knowledge query",
      ok: false,
      fallback: false,
      query_id: `knowledge_query:${query_hash.slice(7)}`,
      receipt: {
        receipt_id: knowledgeQueryHttpReceiptId(receiptWithoutId),
        result_set_hash: receiptWithoutId.result_set_hash,
        index_generation: "generation-1"
      },
      errors: [{ code: "REMOTE_UNAVAILABLE" }]
    });
    expect(output.receipt).not.toHaveProperty("failure_code");
    expect(JSON.stringify(output)).not.toContain("BACKEND_SECRET");
  });

  it.each([
    ["malformed JSON", async () => new Response("server secret", { status: 200 })],
    ["throwing response body", async () => ({
      status: 200,
      text: vi.fn(async () => { throw new Error("body secret"); })
    }) as unknown as Response],
    ["network failure", async () => { throw new Error("network secret"); }]
  ])("maps %s transport failures without leaking the raw error", async (_name, response) => {
    const fetch = vi.fn(response);
    const code = await runCli(["knowledge", "query", "传输失败", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: { ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code).toBe(3);
    expect(stderr.join("\n")).toContain("远端知识查询不可用");
    expect(stderr.join("\n")).not.toMatch(/secret/iu);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      errors: [{ code: "REMOTE_UNAVAILABLE", message: "远端知识查询不可用" }]
    });
    expect(JSON.stringify(stdout)).not.toMatch(/secret/iu);
  });

  it("bounds the remote response before parsing an oversized body", async () => {
    const fetch = vi.fn(async () => new Response("x".repeat(200 * 1024), { status: 200 }));
    const code = await runCli(["knowledge", "query", "超大响应", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: { ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code).toBe(3);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      errors: [{ code: "REMOTE_UNAVAILABLE", message: "远端知识查询不可用" }]
    });
  });
});
