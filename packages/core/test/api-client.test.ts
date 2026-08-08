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

  it("uploads a change archive as one ZIP request", async () => {
    const fetch = vi.fn().mockResolvedValue(json({
      schema_version: 1,
      archive_id: "arc_one",
      project_id: "prj_one",
      change_key: "change-one",
      package_sha256: "sha256:" + "a".repeat(64),
      manifest_sha256: "sha256:" + "b".repeat(64),
      artifact_id: "art_one",
      archive_status: "durable",
      knowledge_status: "ready",
      stored_files: 3,
      uploaded_at: "2026-08-08T00:00:00.000Z",
      request_id: "request-one"
    }, 201));
    const client = new HunterHarnessApiClient({
      serverUrl: "https://example.test",
      token: "token",
      fetch
    });
    const method = (client as unknown as {
      uploadChangeArchivePackage?: (options: {
        projectId: string;
        changeKey: string;
        archive: Uint8Array;
        requestId: string;
        idempotencyKey: string;
      }) => Promise<unknown>;
    }).uploadChangeArchivePackage;
    expect(typeof method).toBe("function");
    if (method === undefined) return;

    await method.call(client, {
      projectId: "prj_one",
      changeKey: "change-one",
      archive: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      requestId: "019ee27b-2a74-7131-a168-32153f38f3c9",
      idempotencyKey: "019ee27b-2a75-7131-a168-32153f38f3c9"
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://example.test/api/v1/projects/prj_one/changes/change-one/archive-package"
    );
    const request = fetch.mock.calls[0]?.[1];
    expect(request?.method).toBe("PUT");
    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/zip");
    expect(request?.body).toBeInstanceOf(Uint8Array);
  });
});
