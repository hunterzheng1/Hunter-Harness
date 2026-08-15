import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  REMOTE_CONTENT_UPLOAD_HTTP_MAX_BYTES,
  REMOTE_CONTENT_UPLOAD_HTTP_MAX_CHUNK_BYTES,
  REMOTE_CONTENT_UPLOAD_HTTP_MAX_EXPIRY_MS,
  REMOTE_CONTENT_UPLOAD_HTTP_MAX_REMOTE_SYNC_FILE_BYTES,
  REMOTE_CONTENT_UPLOAD_HTTP_ERROR_CODES,
  REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS,
  remoteContentUploadHttpRecordHash,
  remoteContentUploadHttpScopeSchema,
  validateRemoteContentUploadHttpRequestDescriptor,
  validateRemoteContentUploadHttpErrorEnvelope,
  validateRemoteContentUploadHttpResult,
  validateRemoteContentUploadHttpStatus,
  validateRemoteContentUploadHttpStatusDescriptor
} from "../src/index.js";
import { isRuntimeProxy } from "../src/browser-safe-proxy.js";
import { sha256Text } from "../src/browser-safe-sha256.js";

const CONTENT_SHA256 = `sha256:${"a".repeat(64)}` as const;
const IDEMPOTENCY_KEY = `sha256:${"b".repeat(64)}` as const;
const uploadDescriptor = {
  schema_version: 1 as const,
  purpose: "remote_archive" as const,
  path: { project_id: "project-http", branch_name: "main" },
  auth: { actor_id: "actor-http" },
  headers: {
    "Content-Type": "application/zip" as const,
    "Content-Length": "42",
    "Idempotency-Key": IDEMPOTENCY_KEY,
    "X-Content-SHA256": CONTENT_SHA256,
    "X-Upload-Expires-In-Ms": "60000",
    "X-Commit-SHA": "commit-http",
    "X-Client-Id": "client-http",
    "X-Change-Key": "change-http"
  },
  body_stream: {
    kind: "single_binary_stream" as const,
    media_type: "application/zip" as const,
    content_encoding: "identity" as const,
    content_length_bytes: 42,
    content_sha256: CONTENT_SHA256,
    max_chunk_bytes: 1024 * 1024
  }
};
const fileUploadDescriptor = {
  ...uploadDescriptor,
  purpose: "remote_sync_file" as const,
  headers: { ...uploadDescriptor.headers, "Content-Type": "application/octet-stream" as const },
  body_stream: { ...uploadDescriptor.body_stream, media_type: "application/octet-stream" as const }
};
const UPLOAD_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const uploadRecord = {
  schema_version: 1 as const,
  upload_id: `remote_content_upload:${UPLOAD_TOKEN}`,
  source: {
    project_id: "project-http",
    branch_name: "main",
    actor_id: "actor-http",
    commit_sha: "commit-http",
    client_id: "client-http",
    change_key: "change-http"
  },
  idempotency_key: IDEMPOTENCY_KEY,
  purpose: "remote_archive" as const,
  content_sha256: CONTENT_SHA256,
  size_bytes: 42,
  upload_ref: {
    ref_id: `bounded_upload:${UPLOAD_TOKEN}`,
    sha256: CONTENT_SHA256,
    size_bytes: 42
  },
  state: "stored" as const,
  created_at: "2026-08-15T10:00:00.000Z",
  expires_at: "2026-08-15T10:01:00.000Z",
  record_hash: "sha256:53a2da17b259dc8a71d9050bc77918745a82c785b440b91fd427e632192cc9da"
};

describe("remote content upload HTTP v1 contract", () => {
  it("keeps the synchronous browser SHA-256 helper byte-identical to Node across blocks", () => {
    for (const value of ["", "abc", "hello", "a".repeat(1_000), "你好🌏"]) {
      expect(sha256Text(value)).toBe(createHash("sha256").update(value).digest("hex"));
    }
  });

  it("keeps the shared runtime contract free of static Node builtins", async () => {
    const source = await readFile(new URL("../src/remote-content-upload-http.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["']node:/u);
  });

  it("fails closed without touching accessors when the Node proxy intrinsic is unavailable", () => {
    const originalProcess = Object.getOwnPropertyDescriptor(globalThis, "process");
    let hits = 0;
    const accessor = {};
    Object.defineProperty(accessor, "secret", { enumerable: true, get: () => { hits += 1; return "secret"; } });

    Object.defineProperty(globalThis, "process", { configurable: true, value: undefined });
    try {
      expect(isRuntimeProxy(accessor)).toBe(true);
      expect(hits).toBe(0);
    } finally {
      if (originalProcess === undefined) delete (globalThis as { process?: unknown }).process;
      else Object.defineProperty(globalThis, "process", originalProcess);
    }
  });

  it("freezes one binary upload plus scoped ambiguity lookup under server authority", () => {
    expect(remoteContentUploadHttpScopeSchema.options).toEqual([
      "archive:read", "archive:write", "files:read", "files:write"
    ]);
    expect([
      REMOTE_CONTENT_UPLOAD_HTTP_MAX_BYTES,
      REMOTE_CONTENT_UPLOAD_HTTP_MAX_CHUNK_BYTES,
      REMOTE_CONTENT_UPLOAD_HTTP_MAX_EXPIRY_MS,
      REMOTE_CONTENT_UPLOAD_HTTP_MAX_REMOTE_SYNC_FILE_BYTES
    ]).toEqual([512 * 1024 * 1024, 1024 * 1024, 15 * 60_000, 10 * 1024 * 1024]);
    expect(REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS.upload_content).toMatchObject({
      method: "POST",
      path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/content-upload",
      operation_id: "stageRemoteContentUpload",
      request_placement: "path_headers_and_binary_body",
      request_media_type: "application/zip",
      body_transport: "single_bounded_stream",
      auth: {
        actor_source: "authenticated_principal",
        project_allowlist_source: "server_authority",
        project_key_scope: "archive:write"
      },
      request_descriptor_schema: "RemoteContentUploadHttpRequestDescriptor",
      success_status: 201,
      replay_status: 200,
      success_schema: "RemoteContentUploadHttpResult"
    });
    expect(REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS.upload_content.identity_bindings).toEqual([
      ["path.project_id", "response.record.source.project_id"],
      ["path.branch_name", "response.record.source.branch_name"],
      ["auth.actor_id", "response.record.source.actor_id"],
      ["header.Idempotency-Key", "response.record.idempotency_key"],
      ["header.X-Content-SHA256", "body_stream.content_sha256"],
      ["header.Content-Length", "body_stream.content_length_bytes"],
      ["header.X-Commit-SHA", "response.record.source.commit_sha"],
      ["header.X-Client-Id", "response.record.source.client_id"],
      ["header.X-Change-Key", "response.record.source.change_key"],
      ["header.X-Upload-Expires-In-Ms", "response.record.created_at..expires_at"]
    ]);
    expect(REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS.upload_status).toMatchObject({
      method: "GET",
      path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/content-upload/status",
      operation_id: "getRemoteContentUploadStatus",
      request_placement: "path_and_headers",
      request_descriptor_schema: "RemoteContentUploadHttpStatusDescriptor",
      success_status: 200,
      success_schema: "RemoteContentUploadHttpStatus",
      auth: { project_key_scope: "archive:read" }
    });
    expect(REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS.upload_remote_sync_file).toMatchObject({
      method: "POST",
      path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/file-upload",
      operation_id: "stageRemoteSyncFileUpload",
      request_media_type: "application/octet-stream",
      auth: { project_key_scope: "files:write" },
      request_descriptor_schema: "RemoteContentUploadHttpRequestDescriptor"
    });
    expect(REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS.remote_sync_file_status).toMatchObject({
      method: "GET",
      path: "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/file-upload/status",
      operation_id: "getRemoteSyncFileUploadStatus",
      auth: { project_key_scope: "files:read" },
      request_descriptor_schema: "RemoteContentUploadHttpStatusDescriptor"
    });
    expect(JSON.stringify(REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS)).not.toMatch(
      /base64|range|resum|filesystem|file_path|caller_path/iu
    );
  });

  it("binds canonical headers exactly to one bounded binary body descriptor", () => {
    expect(validateRemoteContentUploadHttpRequestDescriptor(uploadDescriptor))
      .toEqual({ success: true, data: uploadDescriptor });
    expect(validateRemoteContentUploadHttpRequestDescriptor(fileUploadDescriptor))
      .toEqual({ success: true, data: fileUploadDescriptor });
    const invalid = [
      { ...uploadDescriptor, headers: { ...uploadDescriptor.headers, "Content-Type": "application/json" } },
      { ...fileUploadDescriptor, headers: { ...fileUploadDescriptor.headers, "Content-Type": "application/zip" } },
      { ...uploadDescriptor, purpose: "remote_sync_file" },
      { ...uploadDescriptor, headers: { ...uploadDescriptor.headers, "Content-Length": "043" } },
      { ...uploadDescriptor, headers: { ...uploadDescriptor.headers, "Content-Length": "41" } },
      { ...uploadDescriptor, headers: { ...uploadDescriptor.headers, "X-Content-SHA256": `sha256:${"c".repeat(64)}` } },
      { ...uploadDescriptor, headers: { ...uploadDescriptor.headers, "X-Upload-Expires-In-Ms": "900001" } },
      { ...uploadDescriptor, body_stream: { ...uploadDescriptor.body_stream, max_chunk_bytes: 1024 * 1024 + 1 } },
      { ...fileUploadDescriptor,
        headers: { ...fileUploadDescriptor.headers,
          "Content-Length": String(REMOTE_CONTENT_UPLOAD_HTTP_MAX_REMOTE_SYNC_FILE_BYTES + 1) },
        body_stream: { ...fileUploadDescriptor.body_stream,
          content_length_bytes: REMOTE_CONTENT_UPLOAD_HTTP_MAX_REMOTE_SYNC_FILE_BYTES + 1 } },
      { ...uploadDescriptor, body_stream: { ...uploadDescriptor.body_stream, bytes: "base64:forbidden" } }
    ];
    for (const value of invalid) {
      expect(validateRemoteContentUploadHttpRequestDescriptor(value).success).toBe(false);
    }
  });

  it("uses the same full source plus idempotency scope for ambiguity lookup", () => {
    const descriptor = {
      schema_version: 1,
      purpose: "remote_archive",
      path: uploadDescriptor.path,
      auth: uploadDescriptor.auth,
      headers: {
        "Idempotency-Key": IDEMPOTENCY_KEY,
        "X-Commit-SHA": "commit-http",
        "X-Client-Id": "client-http",
        "X-Change-Key": "change-http"
      }
    };
    expect(validateRemoteContentUploadHttpStatusDescriptor(descriptor))
      .toEqual({ success: true, data: descriptor });
    expect(validateRemoteContentUploadHttpStatusDescriptor({ ...descriptor,
      headers: { ...descriptor.headers, "X-Content-SHA256": CONTENT_SHA256 } }).success).toBe(false);
  });

  it("accepts only hash-, size-, expiry-, source-, and state-closed responses", () => {
    const fresh = { outcome: "new" as const, upload_ref: { ...uploadRecord.upload_ref }, record: uploadRecord };
    const replay = { ...fresh, outcome: "replay" as const };
    expect(validateRemoteContentUploadHttpResult(fresh)).toEqual({ success: true, data: fresh });
    expect(validateRemoteContentUploadHttpResult(replay)).toEqual({ success: true, data: replay });
    expect(validateRemoteContentUploadHttpStatus({ state: "stored", record: uploadRecord }).success).toBe(true);
    expect(validateRemoteContentUploadHttpStatus({ state: "expired", record: uploadRecord }).success).toBe(true);
    expect(validateRemoteContentUploadHttpStatus({ state: "unknown", record: null }).success).toBe(true);
    expect(validateRemoteContentUploadHttpResult({ ...fresh,
      upload_ref: { ...uploadRecord.upload_ref, size_bytes: 41 } }).success).toBe(false);
    expect(validateRemoteContentUploadHttpResult({ ...fresh, record: { ...uploadRecord,
      state: "expired", record_hash: "sha256:292083928266a77d0bf73df6ffc6c71c1f240b49d6642f8b8e42e3152a6e220d" } }).success).toBe(false);
    expect(validateRemoteContentUploadHttpResult({ ...fresh, record: { ...uploadRecord,
      expires_at: uploadRecord.created_at,
      record_hash: "sha256:06ddb0cbb97171195ded3f880898f39bfa48f5a964fff09f978efd3ff6e0ece5" } }).success).toBe(false);
    expect(validateRemoteContentUploadHttpResult({ ...fresh, record: { ...uploadRecord,
      expires_at: "2026-08-15T10:15:00.001Z",
      record_hash: "sha256:a3031c1eca58e1e2ec947324dd5f51587ba92e522d9b52a57d77623a77cb3421" } }).success).toBe(false);
    expect(validateRemoteContentUploadHttpStatus({ state: "unknown", record: uploadRecord }).success).toBe(false);
  });

  it("canonicalizes nested source and upload reference field order exactly like Core", () => {
    const { record_hash: canonicalHash, ...canonicalBody } = uploadRecord;
    const reorderedBody = {
      ...canonicalBody,
      source: {
        change_key: canonicalBody.source.change_key,
        actor_id: canonicalBody.source.actor_id,
        client_id: canonicalBody.source.client_id,
        project_id: canonicalBody.source.project_id,
        commit_sha: canonicalBody.source.commit_sha,
        branch_name: canonicalBody.source.branch_name
      },
      upload_ref: {
        size_bytes: canonicalBody.upload_ref.size_bytes,
        sha256: canonicalBody.upload_ref.sha256,
        ref_id: canonicalBody.upload_ref.ref_id
      }
    };
    const canonicalRecord = { ...canonicalBody, record_hash: canonicalHash };
    const reorderedRecord = { ...reorderedBody, record_hash: canonicalHash };

    expect(remoteContentUploadHttpRecordHash(canonicalBody)).toBe(canonicalHash);
    expect(remoteContentUploadHttpRecordHash(reorderedBody)).toBe(canonicalHash);
    expect(validateRemoteContentUploadHttpResult({ outcome: "new", upload_ref: { ...canonicalBody.upload_ref },
      record: canonicalRecord }).success).toBe(true);
    expect(validateRemoteContentUploadHttpResult({ outcome: "new", upload_ref: { ...reorderedBody.upload_ref },
      record: reorderedRecord }).success).toBe(true);
  });

  it("publishes one fixed bounded public error vocabulary and status map", () => {
    expect(REMOTE_CONTENT_UPLOAD_HTTP_ERROR_CODES).toEqual([
      "AUTH_REQUIRED", "TOKEN_INVALID", "SESSION_INVALID", "VALIDATION_FAILED",
      "PROJECT_INFORMATION_FORBIDDEN", "PROJECT_KEY_SCOPE", "PROJECT_KEY_MISMATCH", "REMOTE_UNAVAILABLE",
      "REMOTE_CONTENT_UPLOAD_INPUT_INVALID", "REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT",
      "REMOTE_CONTENT_UPLOAD_STREAM_INVALID", "REMOTE_CONTENT_UPLOAD_HASH_MISMATCH",
      "REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH", "REMOTE_CONTENT_UPLOAD_TOO_LARGE",
      "REMOTE_CONTENT_UPLOAD_ABORTED", "REMOTE_CONTENT_UPLOAD_SCOPE_MISMATCH",
      "REMOTE_CONTENT_UPLOAD_NOT_FOUND", "REMOTE_CONTENT_UPLOAD_EXPIRED",
      "REMOTE_CONTENT_UPLOAD_MEDIA_TYPE_UNSUPPORTED"
    ]);
    expect(REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS.upload_content.errors).toEqual({
      400: ["VALIDATION_FAILED", "REMOTE_CONTENT_UPLOAD_INPUT_INVALID", "REMOTE_CONTENT_UPLOAD_STREAM_INVALID",
        "REMOTE_CONTENT_UPLOAD_HASH_MISMATCH", "REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH"],
      401: ["AUTH_REQUIRED", "TOKEN_INVALID", "SESSION_INVALID"],
      403: ["PROJECT_INFORMATION_FORBIDDEN", "PROJECT_KEY_SCOPE", "PROJECT_KEY_MISMATCH"],
      409: ["REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT"],
      410: ["REMOTE_CONTENT_UPLOAD_EXPIRED"],
      413: ["REMOTE_CONTENT_UPLOAD_TOO_LARGE"],
      415: ["REMOTE_CONTENT_UPLOAD_MEDIA_TYPE_UNSUPPORTED"],
      499: ["REMOTE_CONTENT_UPLOAD_ABORTED"],
      503: ["REMOTE_UNAVAILABLE"]
    });
    const error = { error: { code: "VALIDATION_FAILED", message: "invalid", request_id: randomUUID(),
      details: { header: "Content-Length" } } };
    expect(validateRemoteContentUploadHttpErrorEnvelope(error)).toEqual({ success: true, data: error });
    expect(validateRemoteContentUploadHttpErrorEnvelope({ ...error, error: { ...error.error,
      details: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, "v"])) } }).success).toBe(false);
    expect(validateRemoteContentUploadHttpErrorEnvelope({ ...error, error: { ...error.error,
      details: { field: "x".repeat(2_001) } } }).success).toBe(false);
  });

  it("parses the byte-frozen descriptor and responses without embedding ZIP bytes", async () => {
    const serialized = await readFile(
      new URL("./fixtures/remote-content-upload-http-v1-current.json", import.meta.url),
      "utf8"
    );
    const fixture = JSON.parse(serialized) as Record<string, unknown>;
    expect(`${JSON.stringify(fixture)}\n`).toBe(serialized);
    expect(validateRemoteContentUploadHttpRequestDescriptor(fixture.upload_descriptor).success).toBe(true);
    expect(validateRemoteContentUploadHttpStatusDescriptor(fixture.status_descriptor).success).toBe(true);
    expect(validateRemoteContentUploadHttpResult(fixture.new_response).success).toBe(true);
    expect(validateRemoteContentUploadHttpResult(fixture.replay_response).success).toBe(true);
    expect(validateRemoteContentUploadHttpStatus(fixture.unknown_status_response).success).toBe(true);
    expect(serialized).not.toMatch(/base64|range|resum|filesystem|file_path|caller_path|package_bytes|"bytes"/iu);
  });

  it("rejects hostile descriptor shapes and resource bombs without executing user code", () => {
    let executions = 0;
    const execute = () => { executions += 1; throw new Error("must not execute"); };
    const hostileProxy = new Proxy(uploadDescriptor, {
      get: execute,
      getOwnPropertyDescriptor: execute,
      getPrototypeOf: execute,
      ownKeys: execute
    });
    const accessorDescriptor = { ...uploadDescriptor };
    Object.defineProperty(accessorDescriptor, "headers", { enumerable: true, get: execute });
    const thenableDescriptor = { ...uploadDescriptor };
    Object.defineProperty(thenableDescriptor, "then", { enumerable: true, get: execute });
    const oversizedDescriptor = { ...uploadDescriptor, headers: {
      ...uploadDescriptor.headers, "X-Commit-SHA": "x".repeat(2_001)
    } };
    const nodeBomb = { ...uploadDescriptor, metadata: Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`node_${index}`, {}])
    ) };

    for (const descriptor of [hostileProxy, accessorDescriptor, thenableDescriptor, oversizedDescriptor, nodeBomb]) {
      expect(validateRemoteContentUploadHttpRequestDescriptor(descriptor).success).toBe(false);
    }
    expect(executions).toBe(0);
  });
});
