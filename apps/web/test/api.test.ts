import { describe, expect, it, vi } from "vitest";

import {
  HttpHunterApi,
  sha256Text,
  type ProjectFileProposalInput
} from "../lib/api";
import { classifyManagedFile } from "../lib/file-policy";
import { reconstructWorkspace } from "../lib/workspace";

const sha = (character: string) => "sha256:" + character.repeat(64);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("Web governance API", () => {
  it("adds request and idempotency UUIDs to bodyless mutations", async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      return Response.json({
        project_id: "prj_one",
        display_name: "Project One",
        lifecycle_state: "archived",
        archived_at: "2026-07-15T00:00:00.000Z",
        purge_after: "2026-08-14T00:00:00.000Z",
        purged_at: null
      });
    });
    const api = new HttpHunterApi({
      baseUrl: "https://console.test",
      tokenProvider: () => "session-token",
      fetch: fetch as unknown as typeof globalThis.fetch
    });

    await api.archiveProject("prj_one");

    const headers = new Headers(calls[0]?.headers);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.body).toBeUndefined();
    expect(headers.get("X-Request-Id")).toMatch(uuid);
    expect(headers.get("Idempotency-Key")).toMatch(uuid);
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("adds a request UUID but no idempotency key to reads", async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      return Response.json({ items: [], page: { next_cursor: null } });
    });
    const api = new HttpHunterApi({
      baseUrl: "https://console.test",
      tokenProvider: () => "session-token",
      fetch: fetch as unknown as typeof globalThis.fetch
    });

    await api.listProjects();

    const headers = new Headers(calls[0]?.headers);
    expect(headers.get("X-Request-Id")).toMatch(uuid);
    expect(headers.has("Idempotency-Key")).toBe(false);
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("projects server file safety into deterministic Web policies", () => {
    expect(classifyManagedFile("CLAUDE.md")).toMatchObject({
      file_kind: "user_editable",
      edit_policy: "managed-block-only",
      push_policy: "diff-proposal"
    });
    expect(classifyManagedFile(".harness/knowledge/project-local/private.md")).toMatchObject({
      push_policy: "confirm-before-proposal",
      update_policy: "never"
    });
    expect(classifyManagedFile(".harness/state/baseline/manifest.json")).toMatchObject({
      file_kind: "internal_state",
      edit_policy: "protocol-only"
    });
  });

  it("reconstructs current files from an approved artifact chain", () => {
    const files = reconstructWorkspace([
      {
        artifactId: "art_1",
        createdAt: "2026-06-20T00:00:00.000Z",
        manifest: {
          schema_version: 1,
          project_id: "prj_one",
          project_version: "pv_1",
          artifact_id: "art_1",
          manifest_sha256: sha("a"),
          files: [{
            operation: "add",
            path: ".harness/knowledge/architecture.md",
            file_kind: "user_editable",
            content_sha256: sha("b"),
            size_bytes: 5
          }]
        },
        textByHash: new Map([[sha("b"), "first"]])
      },
      {
        artifactId: "art_2",
        createdAt: "2026-06-21T00:00:00.000Z",
        manifest: {
          schema_version: 1,
          project_id: "prj_one",
          project_version: "pv_2",
          artifact_id: "art_2",
          manifest_sha256: sha("c"),
          files: [{
            operation: "rename",
            from_path: ".harness/knowledge/architecture.md",
            to_path: ".harness/knowledge/system.md",
            file_kind: "user_editable",
            base_content_sha256: sha("b"),
            content_sha256: sha("b"),
            size_bytes: 5
          }]
        },
        textByHash: new Map([[sha("b"), "first"]])
      }
    ]);

    expect(files).toEqual([expect.objectContaining({
      path: ".harness/knowledge/system.md",
      content: "first",
      content_sha256: sha("b")
    })]);
  });

  it("reads an artifact blob and submits a file edit as a proposal", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const hash = await sha256Text("updated");
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/blobs/" + encodeURIComponent(hash))) {
        return new Response("updated", {
          headers: { "X-Content-SHA256": hash }
        });
      }
      if (url.endsWith("/proposal-sessions")) {
        return Response.json({
          session_id: "ups_one",
          expires_at: "2026-07-01T00:00:00.000Z",
          missing_blobs: [hash],
          max_chunk_bytes: 4_194_304
        });
      }
      if (url.includes("/blobs/")) {
        return Response.json({ received_ranges: [[0, 6]], verified: true });
      }
      if (url.endsWith(":finalize")) {
        return Response.json({ proposal_id: "prp_one", status: "pending_review", received_files: 1 });
      }
      throw new Error("unexpected URL " + url);
    });
    const api = new HttpHunterApi({
      baseUrl: "https://console.test",
      tokenProvider: () => "session-token",
      fetch: fetch as unknown as typeof globalThis.fetch
    });
    await expect(api.getArtifactText("art_one", hash)).resolves.toBe("updated");
    const input: ProjectFileProposalInput = {
      projectId: "prj_one",
      baseProjectVersion: "pv_1",
      baseManifestHash: sha("a"),
      action: "modify",
      path: ".claude/rules/review.md",
      baseContentHash: sha("c"),
      content: "updated",
      fileKind: "user_editable",
      confirmProjectLocal: false
    };
    await expect(api.createProjectFileProposal(input)).resolves.toMatchObject({
      proposal_id: "prp_one",
      status: "pending_review"
    });

    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ["GET", "https://console.test/api/v1/artifacts/art_one/blobs/" + encodeURIComponent(hash)],
      ["POST", "https://console.test/api/v1/projects/prj_one/proposal-sessions"],
      ["PUT", expect.stringContaining("/api/v1/proposal-sessions/ups_one/blobs/")],
      ["POST", "https://console.test/api/v1/proposal-sessions/ups_one:finalize"]
    ]);
    const sessionBody = JSON.parse(String(calls[1]?.init?.body));
    expect(sessionBody.client_id).toBe("cli_web_console");
    expect(sessionBody.proposal_manifest.files).toHaveLength(1);
    expect(calls[2]?.init?.headers).toEqual(expect.objectContaining({
      "Content-Type": "application/octet-stream"
    }));
  });

  it("confirms both paths when a rename touches project-local knowledge", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/proposal-sessions")) {
        return Response.json({ session_id: "ups_rename", missing_blobs: [] });
      }
      if (url.endsWith(":finalize")) {
        return Response.json({ proposal_id: "prp_rename", status: "pending_review", received_files: 1 });
      }
      throw new Error("unexpected URL " + url);
    });
    const api = new HttpHunterApi({
      baseUrl: "https://console.test",
      tokenProvider: () => "session-token",
      fetch: fetch as unknown as typeof globalThis.fetch
    });
    await api.createProjectFileProposal({
      projectId: "prj_one",
      baseProjectVersion: "pv_1",
      baseManifestHash: sha("a"),
      action: "rename",
      path: ".harness/knowledge/project-local/from.md",
      targetPath: ".harness/knowledge/project-local/to.md",
      baseContentHash: sha("b"),
      content: "moved",
      fileKind: "user_editable",
      confirmProjectLocal: true
    });
    const sessionBody = JSON.parse(String(calls[0]?.init?.body));
    expect(sessionBody.confirmations.project_local_paths).toEqual([
      ".harness/knowledge/project-local/from.md",
      ".harness/knowledge/project-local/to.md"
    ]);
  });
});
