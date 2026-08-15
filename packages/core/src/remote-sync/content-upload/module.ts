import { createHash, randomBytes } from "node:crypto";
import { isPromise, isProxy } from "node:util/types";

import { REMOTE_SYNC_MAX_CHUNK_BYTES, type RemoteSyncContentChunk } from "../v1.js";
import {
  REMOTE_CONTENT_UPLOAD_MAX_BYTES,
  REMOTE_CONTENT_UPLOAD_MAX_EXPIRY_MS,
  type RemoteContentUploadErrorCode,
  type RemoteContentUploadRecord,
  type RemoteContentUploadRef,
  type RemoteContentUploadRequest,
  type RemoteContentUploadRecordReadResult,
  type RemoteContentUploadResult,
  type RemoteContentUploadSha256,
  type RemoteContentUploadSource,
  type RemoteContentUploadStaging,
  type RemoteContentUploadStatus
} from "./types.js";

const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const uint8ArraySet = Uint8Array.prototype.set;

export class RemoteContentUploadError extends Error {
  constructor(readonly code: RemoteContentUploadErrorCode) {
    super(code);
    this.name = "RemoteContentUploadError";
  }
}

function fail(code: RemoteContentUploadErrorCode): never { throw new RemoteContentUploadError(code); }
const sha256 = (value: Uint8Array | string): RemoteContentUploadSha256 =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum &&
  [...value].every((character) => {
    const codepoint = character.codePointAt(0) ?? 0;
    return codepoint > 31 && codepoint !== 127 && !(codepoint >= 0xd800 && codepoint <= 0xdfff);
  });
const hash = (value: unknown): value is RemoteContentUploadSha256 =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);

function dataRecord(
  value: unknown,
  keys: readonly string[],
  code: RemoteContentUploadErrorCode = "REMOTE_CONTENT_UPLOAD_INPUT_INVALID"
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined)) {
    fail(code);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]));
}

function source(value: unknown): RemoteContentUploadSource {
  const required = ["project_id", "branch_name", "actor_id"];
  if (value === null || typeof value !== "object" || isProxy(value)) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = [...required, "commit_sha", "client_id", "change_key"];
  if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(descriptors).some((key) =>
    typeof key !== "string" || !allowed.includes(key)) || required.some((key) => descriptors[key] === undefined) ||
    Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true)) {
    fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
  }
  const safe = Object.fromEntries(allowed.map((key) => [key, descriptors[key]?.value]));
  if (!text(safe.project_id, 160) || !text(safe.branch_name, 160) || !text(safe.actor_id, 160)) {
    fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
  }
  for (const key of ["commit_sha", "client_id", "change_key"] as const) {
    if (safe[key] !== undefined && !text(safe[key], 240)) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
  }
  return { project_id: safe.project_id, branch_name: safe.branch_name, actor_id: safe.actor_id,
    ...(safe.commit_sha === undefined ? {} : { commit_sha: safe.commit_sha as string }),
    ...(safe.client_id === undefined ? {} : { client_id: safe.client_id as string }),
    ...(safe.change_key === undefined ? {} : { change_key: safe.change_key as string }) };
}

function request(value: unknown): RemoteContentUploadRequest {
  const safe = dataRecord(value, ["schema_version", "source", "idempotency_key", "purpose", "content_sha256", "size_bytes", "expires_in_ms"]);
  if (safe.schema_version !== 1 || safe.purpose !== "remote_archive" || !hash(safe.idempotency_key) || !hash(safe.content_sha256) ||
      typeof safe.size_bytes !== "number" || !Number.isSafeInteger(safe.size_bytes) || safe.size_bytes < 1 ||
      typeof safe.expires_in_ms !== "number" || !Number.isSafeInteger(safe.expires_in_ms) || safe.expires_in_ms < 1 ||
      safe.expires_in_ms > REMOTE_CONTENT_UPLOAD_MAX_EXPIRY_MS) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
  if (safe.size_bytes > REMOTE_CONTENT_UPLOAD_MAX_BYTES) fail("REMOTE_CONTENT_UPLOAD_TOO_LARGE");
  return { schema_version: 1, source: source(safe.source), idempotency_key: safe.idempotency_key, purpose: "remote_archive",
    content_sha256: safe.content_sha256, size_bytes: safe.size_bytes, expires_in_ms: safe.expires_in_ms };
}

function sameSource(left: RemoteContentUploadSource, right: RemoteContentUploadSource): boolean {
  return left.project_id === right.project_id && left.branch_name === right.branch_name && left.actor_id === right.actor_id &&
    (left.commit_sha ?? null) === (right.commit_sha ?? null) && (left.client_id ?? null) === (right.client_id ?? null) &&
    (left.change_key ?? null) === (right.change_key ?? null);
}

function aborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (isProxy(signal) || abortGetter === undefined) fail("REMOTE_CONTENT_UPLOAD_ABORTED");
  try { return Reflect.apply(abortGetter, signal, []) as boolean; } catch { fail("REMOTE_CONTENT_UPLOAD_ABORTED"); }
}

function method(value: unknown, key: string | symbol): { readonly receiver: object; readonly value: (...args: never[]) => unknown } {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || isProxy(value)) {
    fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
  }
  let receiver: object | null = value;
  while (receiver !== null) {
    if (isProxy(receiver)) fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
    const descriptor = Object.getOwnPropertyDescriptor(receiver, key);
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function" || isProxy(descriptor.value)) {
        fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
      }
      return { receiver: value, value: descriptor.value as (...args: never[]) => unknown };
    }
    receiver = Object.getPrototypeOf(receiver) as object | null;
  }
  fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
}

async function trustedPromise<T>(value: unknown): Promise<T> {
  if (isProxy(value) || !isPromise(value) || Object.getPrototypeOf(value) !== Promise.prototype ||
      Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).length !== 0) fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
  try { return await value as T; } catch { fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID"); }
}

function contentChunk(value: unknown): RemoteSyncContentChunk {
  const safe = dataRecord(value, ["sequence", "offset", "size", "chunk_hash", "final", "bytes"],
    "REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
  const rawBytes = safe.bytes;
  if (isProxy(rawBytes) || !(rawBytes instanceof Uint8Array) || Object.getPrototypeOf(rawBytes) !== Uint8Array.prototype ||
      typedArrayByteLengthGetter === undefined) fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
  let byteLength: number;
  try { byteLength = Reflect.apply(typedArrayByteLengthGetter, rawBytes, []) as number; }
  catch { fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID"); }
  if (typeof safe.sequence !== "number" || !Number.isSafeInteger(safe.sequence) || safe.sequence < 0 ||
      typeof safe.offset !== "number" || !Number.isSafeInteger(safe.offset) || safe.offset < 0 ||
      typeof safe.size !== "number" || !Number.isSafeInteger(safe.size) || safe.size !== byteLength ||
      byteLength > REMOTE_SYNC_MAX_CHUNK_BYTES || !hash(safe.chunk_hash) ||
      typeof safe.final !== "boolean") fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
  let copy: Uint8Array;
  try { copy = new Uint8Array(byteLength); Reflect.apply(uint8ArraySet, copy, [rawBytes, 0]); }
  catch { fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID"); }
  if (sha256(copy) !== safe.chunk_hash) fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
  return { sequence: safe.sequence, offset: safe.offset, size: safe.size, chunk_hash: safe.chunk_hash,
    final: safe.final, bytes: copy };
}

async function consume(
  content: AsyncIterable<RemoteSyncContentChunk>,
  expected: RemoteContentUploadRequest,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (aborted(signal)) fail("REMOTE_CONTENT_UPLOAD_ABORTED");
  const iterable = method(content, Symbol.asyncIterator);
  let iterator: unknown;
  try { iterator = Reflect.apply(iterable.value, iterable.receiver, []); } catch { fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID"); }
  const next = method(iterator, "next");
  let output: Uint8Array;
  try { output = new Uint8Array(expected.size_bytes); } catch { fail("REMOTE_CONTENT_UPLOAD_TOO_LARGE"); }
  const digest = createHash("sha256");
  let sequence = 0; let offset = 0; let final = false;
  while (!final) {
    if (aborted(signal)) fail("REMOTE_CONTENT_UPLOAD_ABORTED");
    let result: unknown;
    try { result = await trustedPromise(Reflect.apply(next.value, next.receiver, [])); }
    catch (error) { if (error instanceof RemoteContentUploadError) throw error; fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID"); }
    const safe = dataRecord(result, ["value", "done"], "REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
    if (safe.done === true) fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
    if (safe.done !== false) fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
    const chunk = contentChunk(safe.value);
    if (chunk.sequence !== sequence || chunk.offset !== offset || chunk.size < 1 || offset + chunk.size > expected.size_bytes) {
      fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
    }
    output.set(chunk.bytes, offset); digest.update(chunk.bytes);
    sequence += 1; offset += chunk.bytes.byteLength; final = chunk.final;
  }
  let trailing: { done: boolean; value?: unknown };
  try { trailing = await trustedPromise(Reflect.apply(next.value, next.receiver, [])); }
  catch (error) { if (error instanceof RemoteContentUploadError) throw error; fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID"); }
  const trailingSafe = dataRecord(trailing, ["value", "done"], "REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
  if (trailingSafe.done !== true || trailingSafe.value !== undefined) fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
  if (aborted(signal)) fail("REMOTE_CONTENT_UPLOAD_ABORTED");
  if (offset !== expected.size_bytes) fail("REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH");
  if (`sha256:${digest.digest("hex")}` !== expected.content_sha256) fail("REMOTE_CONTENT_UPLOAD_HASH_MISMATCH");
  return output;
}

function canonicalRecordBody(value: Omit<RemoteContentUploadRecord, "record_hash">): string {
  return JSON.stringify({ schema_version: value.schema_version, upload_id: value.upload_id, source: value.source,
    idempotency_key: value.idempotency_key, purpose: value.purpose, content_sha256: value.content_sha256, size_bytes: value.size_bytes,
    upload_ref: value.upload_ref, state: value.state, created_at: value.created_at, expires_at: value.expires_at });
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

export function normalizeRemoteContentUploadRecord(value: unknown): RemoteContentUploadRecordReadResult {
  try {
    const safe = dataRecord(value, ["schema_version", "upload_id", "source", "idempotency_key", "purpose",
      "content_sha256", "size_bytes", "upload_ref", "state", "created_at", "expires_at", "record_hash"]);
    const safeSource = source(safe.source);
    const ref = dataRecord(safe.upload_ref, ["ref_id", "sha256", "size_bytes"]);
    if (safe.schema_version !== 1 || safe.purpose !== "remote_archive" || safe.state !== "stored" ||
        !text(safe.upload_id, 240) || !String(safe.upload_id).startsWith("remote_content_upload:") ||
        !hash(safe.idempotency_key) || !hash(safe.content_sha256) || !hash(safe.record_hash) ||
        typeof safe.size_bytes !== "number" || !Number.isSafeInteger(safe.size_bytes) || safe.size_bytes < 1 ||
        safe.size_bytes > REMOTE_CONTENT_UPLOAD_MAX_BYTES || !text(ref.ref_id, 240) ||
        !String(ref.ref_id).startsWith("bounded_upload:") || !hash(ref.sha256) ||
        typeof ref.size_bytes !== "number" || ref.size_bytes !== safe.size_bytes || ref.sha256 !== safe.content_sha256 ||
        String(safe.upload_id).slice("remote_content_upload:".length) !== String(ref.ref_id).slice("bounded_upload:".length) ||
        typeof safe.created_at !== "string" || typeof safe.expires_at !== "string") {
      fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
    }
    const created = Date.parse(safe.created_at); const expires = Date.parse(safe.expires_at);
    if (!Number.isFinite(created) || !Number.isFinite(expires) || new Date(created).toISOString() !== safe.created_at ||
        new Date(expires).toISOString() !== safe.expires_at || expires <= created ||
        expires - created > REMOTE_CONTENT_UPLOAD_MAX_EXPIRY_MS) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
    const body = { schema_version: 1 as const, upload_id: safe.upload_id as RemoteContentUploadRecord["upload_id"],
      source: safeSource, idempotency_key: safe.idempotency_key, purpose: "remote_archive" as const,
      content_sha256: safe.content_sha256, size_bytes: safe.size_bytes,
      upload_ref: { ref_id: ref.ref_id as RemoteContentUploadRef["ref_id"], sha256: ref.sha256, size_bytes: ref.size_bytes },
      state: "stored" as const, created_at: safe.created_at, expires_at: safe.expires_at };
    if (sha256(canonicalRecordBody(body)) !== safe.record_hash) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
    return { ok: true, record: frozen({ ...body, record_hash: safe.record_hash }) };
  } catch {
    return { ok: false, reason_code: "REMOTE_CONTENT_UPLOAD_INPUT_INVALID" };
  }
}

export function createInMemoryRemoteContentUploadStaging(options: { readonly clock?: () => Date } = {}): RemoteContentUploadStaging {
  if (isProxy(options) || options === null || typeof options !== "object" || Array.isArray(options) ||
      Object.getPrototypeOf(options) !== Object.prototype) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
  const optionDescriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(optionDescriptors).some((value) => value !== "clock") ||
      Object.values(optionDescriptors).some((descriptor) => !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true)) {
    fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
  }
  const clock = optionDescriptors.clock?.value === undefined ? (() => new Date()) : optionDescriptors.clock.value;
  if (typeof clock !== "function" || isProxy(clock)) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
  const byKey = new Map<string, RemoteContentUploadRecord>();
  const bytesByRef = new Map<string, Uint8Array>();
  const tails = new Map<string, Promise<void>>();
  const key = (value: RemoteContentUploadSource, idempotency: string) => JSON.stringify([value.project_id, value.branch_name,
    value.actor_id, value.commit_sha ?? null, value.client_id ?? null, value.change_key ?? null, idempotency]);
  const currentTime = (): Date => { const value = Reflect.apply(clock as () => Date, undefined, []);
    if (isProxy(value) || !(value instanceof Date)) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
    let time: number; try { time = Date.prototype.getTime.call(value); } catch { fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID"); }
    if (!Number.isFinite(time)) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID"); return new Date(time); };
  const exclusive = async <T>(identity: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(identity) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    tails.set(identity, current);
    await previous;
    try { return await work(); } finally {
      release();
      if (tails.get(identity) === current) tails.delete(identity);
    }
  };

  return {
    async stage(rawRequest, content, signal): Promise<RemoteContentUploadResult> {
      const input = request(rawRequest); const identity = key(input.source, input.idempotency_key);
      return exclusive(identity, async () => {
        const existing = byKey.get(identity);
        if (existing !== undefined) {
          if (existing.content_sha256 !== input.content_sha256 || existing.size_bytes !== input.size_bytes ||
              Date.parse(existing.expires_at) - Date.parse(existing.created_at) !== input.expires_in_ms) {
            fail("REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT");
          }
          if (Date.parse(existing.expires_at) <= currentTime().getTime()) fail("REMOTE_CONTENT_UPLOAD_EXPIRED");
          return frozen({ outcome: "replay", upload_ref: structuredClone(existing.upload_ref), record: structuredClone(existing) });
        }
        const body = await consume(content, input, signal);
        const created = currentTime(); const token = randomBytes(32).toString("base64url");
        const uploadRef: RemoteContentUploadRef = { ref_id: `bounded_upload:${token}`, sha256: input.content_sha256, size_bytes: input.size_bytes };
        const recordBody: Omit<RemoteContentUploadRecord, "record_hash"> = { schema_version: 1,
          upload_id: `remote_content_upload:${token}`, source: input.source, idempotency_key: input.idempotency_key,
          purpose: input.purpose,
          content_sha256: input.content_sha256, size_bytes: input.size_bytes, upload_ref: uploadRef, state: "stored",
          created_at: created.toISOString(), expires_at: new Date(created.getTime() + input.expires_in_ms).toISOString() };
        const record: RemoteContentUploadRecord = { ...recordBody, record_hash: sha256(canonicalRecordBody(recordBody)) };
        byKey.set(identity, structuredClone(record)); bytesByRef.set(uploadRef.ref_id, body);
        return frozen({ outcome: "new", upload_ref: structuredClone(uploadRef), record: structuredClone(record) });
      });
    },
    async status(raw): Promise<RemoteContentUploadStatus> {
      const safe = dataRecord(raw, ["source", "idempotency_key"]);
      const inputSource = source(safe.source); if (!hash(safe.idempotency_key)) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
      const record = byKey.get(key(inputSource, safe.idempotency_key));
      if (record === undefined) return { state: "unknown", record: null };
      return Date.parse(record.expires_at) <= currentTime().getTime()
        ? frozen({ state: "expired", record: structuredClone(record) })
        : frozen({ state: "stored", record: structuredClone(record) });
    },
    async read(rawRef, rawSource): Promise<Uint8Array> {
      const inputSource = source(rawSource);
      const ref = dataRecord(rawRef, ["ref_id", "sha256", "size_bytes"]);
      if (!text(ref.ref_id, 240) || !hash(ref.sha256) || typeof ref.size_bytes !== "number" || !Number.isSafeInteger(ref.size_bytes)) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
      const record = [...byKey.values()].find((candidate) => candidate.upload_ref.ref_id === ref.ref_id);
      if (record === undefined) fail("REMOTE_CONTENT_UPLOAD_NOT_FOUND");
      if (!sameSource(record.source, inputSource)) fail("REMOTE_CONTENT_UPLOAD_SCOPE_MISMATCH");
      if (Date.parse(record.expires_at) <= currentTime().getTime()) fail("REMOTE_CONTENT_UPLOAD_EXPIRED");
      if (record.upload_ref.sha256 !== ref.sha256 || record.upload_ref.size_bytes !== ref.size_bytes) fail("REMOTE_CONTENT_UPLOAD_SCOPE_MISMATCH");
      return bytesByRef.get(ref.ref_id)?.slice() ?? fail("REMOTE_CONTENT_UPLOAD_NOT_FOUND");
    }
  };
}
