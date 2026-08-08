import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/bin.js";

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
    expect(await runCli(["--profile", "general", "--non-interactive", "--yes"], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined,
      env: {}
    })).toBe(0);
    await rm(join(root, ".harness", "knowledge"), { recursive: true, force: true });
    await mkdir(join(root, ".harness"), { recursive: true });
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "server_url: https://platform.example.test\ntoken: knowledge-token\nproject_id: prj_knowledge\n",
      "utf8"
    );
  });

  it("queries only the remote semantic store and leaves no local index", async () => {
    const fetch = vi.fn(async () => json({
      items: [{
        project_id: "prj_knowledge",
        document: {
          document_id: "sem_archive",
          project_id: "prj_knowledge",
          artifact_id: "art_archive",
          kind: "knowledge_markdown",
          source_path: ".harness/archive/change/spec/design.md",
          title: "归档设计",
          body: "原始 ZIP 保留在服务端。",
          metadata: { status: "active" },
          content_sha256: "sha256:" + "a".repeat(64)
        }
      }],
      request_id: "query-request"
    }));

    const code = await runCli([
      "knowledge", "query", "原始 ZIP", "--limit", "5", "--json"
    ], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: {},
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code, stderr.join("\n")).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "/api/v1/semantic/search?q=%E5%8E%9F%E5%A7%8B+ZIP&project_id=prj_knowledge"
    );
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      command: "knowledge query",
      source: "remote",
      fallback: false,
      count: 1
    });
    await expect(import("node:fs/promises").then(({ stat }) =>
      stat(join(root, ".harness", "knowledge"))
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the remote service is unavailable", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const code = await runCli(["knowledge", "query", "历史决策", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetch as unknown as typeof globalThis.fetch,
      env: {},
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
});
