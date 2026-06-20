import { describe, expect, it, vi } from "vitest";

import { HunterHarnessApiClient } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Hunter Harness API client", () => {
  it("requires HTTPS and a non-empty API token", () => {
    expect(() => new HunterHarnessApiClient({
      serverUrl: "http://example.test",
      token: "token",
      fetch: vi.fn()
    })).toThrow(/HTTPS/i);
    expect(() => new HunterHarnessApiClient({
      serverUrl: "https://example.test",
      token: "",
      fetch: vi.fn()
    })).toThrow(/token/i);
  });

  it("retries transient mutations with the same idempotency key", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "SERVICE_UNAVAILABLE", message: "retry", request_id: "req", details: {} } }, 503))
      .mockResolvedValueOnce(json({
        schema_version: 1,
        project_id: "prj_one",
        binding_status: "created",
        project_version: null,
        baseline_manifest: { schema_version: 1, project_id: "prj_one", complete_project_version: null, files: {} },
        request_id: "req"
      }));
    const client = new HunterHarnessApiClient({
      serverUrl: "https://example.test/",
      token: "secret-token",
      fetch,
      sleep: async () => undefined
    });

    await client.resolveProject({
      schema_version: 1,
      local_project_key: "019ee27b-2a6f-7131-a168-32153f38f3c9",
      display_name: "demo",
      requested_project_id: null,
      client_id: "cli_test"
    }, "019ee27b-2a70-7131-a168-32153f38f3c9", "019ee27b-2a71-7131-a168-32153f38f3c9");

    expect(fetch).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get("Idempotency-Key")).toBe(secondHeaders.get("Idempotency-Key"));
    expect(firstHeaders.get("Authorization")).toBe("Bearer secret-token");
  });

  it("uploads resumable chunks with range and integrity headers", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ verified: true }, 201));
    const client = new HunterHarnessApiClient({
      serverUrl: "https://example.test",
      token: "token",
      fetch
    });
    await client.uploadBlobChunk({
      sessionId: "ups_one",
      contentSha256: "sha256:" + "a".repeat(64),
      chunk: new TextEncoder().encode("abc"),
      start: 3,
      total: 6,
      requestId: "019ee27b-2a72-7131-a168-32153f38f3c9",
      idempotencyKey: "019ee27b-2a73-7131-a168-32153f38f3c9"
    });
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Content-Range")).toBe("bytes 3-5/6");
    expect(headers.get("X-Chunk-SHA256")).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
