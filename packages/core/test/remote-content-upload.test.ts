import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  REMOTE_CONTENT_UPLOAD_MAX_BYTES,
  REMOTE_SYNC_MAX_CHUNK_BYTES,
  RemoteContentUploadError,
  createInMemoryRemoteContentUploadStaging,
  normalizeRemoteContentUploadRecord,
  type RemoteContentUploadRequest,
  type RemoteSyncContentChunk
} from "../src/index.js";

const bytes = new TextEncoder().encode("archive bytes");
const sha = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}` as const;

function request(overrides: Partial<RemoteContentUploadRequest> = {}): RemoteContentUploadRequest {
  return {
    schema_version: 1,
    source: { project_id: "prj_upload", branch_name: "main", actor_id: "actor_upload",
      commit_sha: "0123456789abcdef", client_id: "cli_upload", change_key: "change-upload" },
    idempotency_key: `sha256:${"a".repeat(64)}`,
    purpose: "remote_archive",
    content_sha256: sha(bytes),
    size_bytes: bytes.byteLength,
    expires_in_ms: 60_000,
    ...overrides
  };
}

async function* stream(value = bytes): AsyncIterable<RemoteSyncContentChunk> {
  yield { sequence: 0, offset: 0, size: value.byteLength, chunk_hash: sha(value), final: true, bytes: value };
}

describe("Remote content upload staging", () => {
  it("stages one bounded stream and publishes only an opaque hash-bound ref", async () => {
    const staging = createInMemoryRemoteContentUploadStaging({ clock: () => new Date("2026-08-15T00:00:00.000Z") });
    const result = await staging.stage(request(), stream());
    expect(result).toMatchObject({ outcome: "new", record: { state: "stored", source: request().source,
      content_sha256: request().content_sha256, size_bytes: bytes.byteLength }, upload_ref: {
      ref_id: expect.stringMatching(/^bounded_upload:[A-Za-z0-9_-]{43}$/u), sha256: request().content_sha256,
      size_bytes: bytes.byteLength } });
    expect(JSON.stringify(result)).not.toContain("archive bytes");
    expect(Object.isFrozen(result.record.source)).toBe(true);
    expect(normalizeRemoteContentUploadRecord(result.record)).toEqual({ ok: true, record: result.record });
    expect(normalizeRemoteContentUploadRecord({ ...result.record, size_bytes: result.record.size_bytes + 1 }))
      .toEqual({ ok: false, reason_code: "REMOTE_CONTENT_UPLOAD_INPUT_INVALID" });
    expect(await staging.read(result.upload_ref, request().source)).toEqual(bytes);
  });

  it("replays the same identity without consuming another stream and conflicts on changed payload", async () => {
    const staging = createInMemoryRemoteContentUploadStaging();
    const first = await staging.stage(request(), stream());
    let reads = 0;
    const replayStream = { async *[Symbol.asyncIterator]() { reads += 1; yield* stream(); } };
    expect(await staging.stage(request(), replayStream)).toMatchObject({ outcome: "replay", upload_ref: first.upload_ref });
    expect(reads).toBe(0);
    await expect(staging.stage(request({ content_sha256: `sha256:${"b".repeat(64)}` }), stream()))
      .rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT" });
    await expect(staging.stage(request({ expires_in_ms: 120_000 }), stream()))
      .rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT" });
  });

  it("serializes concurrent requests for the same idempotency identity", async () => {
    const staging = createInMemoryRemoteContentUploadStaging();
    let reads = 0;
    const counted = () => ({ async *[Symbol.asyncIterator]() { reads += 1; yield* stream(); } });
    const [left, right] = await Promise.all([staging.stage(request(), counted()), staging.stage(request(), counted())]);
    expect([left.outcome, right.outcome].sort()).toEqual(["new", "replay"]);
    expect(left.upload_ref).toEqual(right.upload_ref);
    expect(reads).toBe(1);
    expect((await staging.status({ source: request().source, idempotency_key: request().idempotency_key })).state)
      .toBe("stored");
  });

  it("releases the per-key fence after a failed stream", async () => {
    const staging = createInMemoryRemoteContentUploadStaging();
    async function* invalid(): AsyncIterable<RemoteSyncContentChunk> {
      yield { sequence: 2, offset: 0, size: bytes.byteLength, chunk_hash: sha(bytes), final: true, bytes };
    }
    await expect(staging.stage(request(), invalid())).rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_STREAM_INVALID" });
    expect(await staging.stage(request(), stream())).toMatchObject({ outcome: "new" });
  });

  it("rejects gaps, wrong hashes, overflow, and aborted input without publishing a ref", async () => {
    const staging = createInMemoryRemoteContentUploadStaging();
    async function* gap(): AsyncIterable<RemoteSyncContentChunk> {
      yield { sequence: 1, offset: 0, size: bytes.byteLength, chunk_hash: sha(bytes), final: true, bytes };
    }
    await expect(staging.stage(request(), gap())).rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_STREAM_INVALID" });
    async function* trailing(): AsyncIterable<RemoteSyncContentChunk> {
      yield { sequence: 0, offset: 0, size: bytes.byteLength, chunk_hash: sha(bytes), final: true, bytes };
      yield { sequence: 1, offset: bytes.byteLength, size: bytes.byteLength, chunk_hash: sha(bytes), final: true, bytes };
    }
    await expect(staging.stage(request(), trailing())).rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_STREAM_INVALID" });
    await expect(staging.stage(request({ size_bytes: bytes.byteLength + 1 }), stream()))
      .rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH" });
    await expect(staging.stage(request({ size_bytes: REMOTE_CONTENT_UPLOAD_MAX_BYTES + 1 }), stream()))
      .rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_TOO_LARGE" });
    const oversized = new Uint8Array(REMOTE_SYNC_MAX_CHUNK_BYTES + 1);
    async function* oversizedChunk(): AsyncIterable<RemoteSyncContentChunk> {
      yield { sequence: 0, offset: 0, size: oversized.byteLength,
        chunk_hash: `sha256:${"f".repeat(64)}`, final: true, bytes: oversized };
    }
    await expect(staging.stage(request({ idempotency_key: `sha256:${"9".repeat(64)}`,
      size_bytes: oversized.byteLength, content_sha256: `sha256:${"f".repeat(64)}` }), oversizedChunk()))
      .rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_STREAM_INVALID" });
    const controller = new AbortController(); controller.abort();
    await expect(staging.stage(request(), stream(), controller.signal))
      .rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_ABORTED" });
    expect((await staging.status({ source: request().source, idempotency_key: request().idempotency_key })).state).toBe("unknown");
  });

  it("rejects hostile stream, chunk, signal, and rejection values without executing traps", async () => {
    const staging = createInMemoryRemoteContentUploadStaging();
    let traps = 0;
    const hostileStream = new Proxy({}, { get() { traps += 1; throw new Error("secret"); } });
    await expect(staging.stage(request(), hostileStream as never)).rejects.toBeInstanceOf(RemoteContentUploadError);
    expect(traps).toBe(0);
    const hostileSignal = Object.defineProperty({}, "aborted", { get() { traps += 1; throw new Error("secret"); } });
    await expect(staging.stage(request(), stream(), hostileSignal as AbortSignal)).rejects.toBeInstanceOf(RemoteContentUploadError);
    expect(traps).toBe(0);
    const hostileChunk = new Proxy({ sequence: 0 }, { get() { traps += 1; throw new Error("secret"); } });
    const hostileChunks = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.resolve({ done: false, value: hostileChunk }) };
      }
    };
    await expect(staging.stage(request(), hostileChunks as never)).rejects.toBeInstanceOf(RemoteContentUploadError);
    expect(traps).toBe(0);
    const throwingTail = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return { next() {
          if (sent) throw new Error("backend secret");
          sent = true;
          return Promise.resolve({ done: false, value: { sequence: 0, offset: 0, size: bytes.byteLength,
            chunk_hash: sha(bytes), final: true, bytes } });
        } };
      }
    };
    await expect(staging.stage(request({ idempotency_key: `sha256:${"e".repeat(64)}` }), throwingTail))
      .rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_STREAM_INVALID", message: "REMOTE_CONTENT_UPLOAD_STREAM_INVALID" });
    const intrinsicBytes = bytes.slice();
    Object.defineProperty(intrinsicBytes, "slice", { get() { traps += 1; throw new Error("secret"); } });
    Object.defineProperty(intrinsicBytes, "byteLength", { get() { traps += 1; throw new Error("secret"); } });
    Object.defineProperty(intrinsicBytes, "constructor", { get() { traps += 1; throw new Error("secret"); } });
    const intrinsicChunks = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return { next: () => Promise.resolve(sent ? { done: true, value: undefined } :
          (sent = true, { done: false, value: { sequence: 0, offset: 0, size: bytes.byteLength,
            chunk_hash: sha(bytes), final: true, bytes: intrinsicBytes } })) };
      }
    };
    expect(await staging.stage(request({ idempotency_key: `sha256:${"c".repeat(64)}` }), intrinsicChunks))
      .toMatchObject({ outcome: "new" });
    expect(traps).toBe(0);
    const speciesBytes = bytes.slice();
    const hostileConstructor = Object.defineProperty({}, Symbol.species,
      { get() { traps += 1; throw new Error("secret"); } });
    Object.defineProperty(speciesBytes, "constructor", { value: hostileConstructor });
    const speciesChunks = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return { next: () => Promise.resolve(sent ? { done: true, value: undefined } :
          (sent = true, { done: false, value: { sequence: 0, offset: 0, size: bytes.byteLength,
            chunk_hash: sha(bytes), final: true, bytes: speciesBytes } })) };
      }
    };
    expect(await staging.stage(request({ idempotency_key: `sha256:${"d".repeat(64)}` }), speciesChunks))
      .toMatchObject({ outcome: "new" });
    expect(traps).toBe(0);
    const hostileStatus = new Proxy({ source: request().source, idempotency_key: request().idempotency_key },
      { get() { traps += 1; throw new Error("secret"); } });
    await expect(staging.status(hostileStatus)).rejects.toBeInstanceOf(RemoteContentUploadError);
    const hostileRef = new Proxy({ ref_id: "bounded_upload:x", sha256: request().content_sha256, size_bytes: bytes.byteLength },
      { get() { traps += 1; throw new Error("secret"); } });
    await expect(staging.read(hostileRef as never, request().source)).rejects.toBeInstanceOf(RemoteContentUploadError);
    expect(traps).toBe(0);
  });

  it("binds status/read to source and expires stored bytes deterministically", async () => {
    let now = Date.parse("2026-08-15T00:00:00.000Z");
    const staging = createInMemoryRemoteContentUploadStaging({ clock: () => new Date(now) });
    const result = await staging.stage(request(), stream());
    await expect(staging.read(result.upload_ref, { ...request().source, actor_id: "other" }))
      .rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_SCOPE_MISMATCH" });
    now += 60_001;
    expect((await staging.status({ source: request().source, idempotency_key: request().idempotency_key })).state).toBe("expired");
    await expect(staging.stage(request(), stream())).rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_EXPIRED" });
    await expect(staging.read(result.upload_ref, request().source))
      .rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_EXPIRED" });
  });
});
