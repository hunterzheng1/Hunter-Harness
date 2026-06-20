import { sha256Bytes } from "@hunter-harness/core";

import { ServerDomainError } from "../repositories/interfaces.js";
import type { ArtifactStorage, ChunkWriteResult } from "./interface.js";

interface PendingBlob {
  bytes: Uint8Array;
  covered: boolean[];
  ranges: Array<{ start: number; end: number }>;
}

export class MemoryArtifactStorage implements ArtifactStorage {
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly pending = new Map<string, PendingBlob>();

  async hasBlob(contentSha256: string): Promise<boolean> {
    return this.blobs.has(contentSha256);
  }

  async getBlob(contentSha256: string): Promise<Uint8Array> {
    const value = this.blobs.get(contentSha256);
    if (value === undefined) {
      throw new ServerDomainError(404, "ARTIFACT_NOT_FOUND", "artifact blob not found");
    }
    return value.slice();
  }

  async putBlob(contentSha256: string, content: Uint8Array): Promise<void> {
    if (sha256Bytes(content) !== contentSha256) {
      throw new ServerDomainError(422, "ARTIFACT_HASH_MISMATCH", "blob hash mismatch");
    }
    this.blobs.set(contentSha256, content.slice());
  }

  async writeSessionChunk(input: {
    sessionId: string;
    contentSha256: string;
    start: number;
    total: number;
    chunk: Uint8Array;
  }): Promise<ChunkWriteResult> {
    const key = input.sessionId + "\0" + input.contentSha256;
    const current = this.pending.get(key) ?? {
      bytes: new Uint8Array(input.total),
      covered: Array.from({ length: input.total }, () => false),
      ranges: []
    };
    if (current.bytes.byteLength !== input.total ||
        input.start < 0 || input.start + input.chunk.byteLength > input.total) {
      throw new ServerDomainError(422, "UPLOAD_RANGE_INVALID", "upload range is invalid");
    }
    current.bytes.set(input.chunk, input.start);
    for (let index = input.start; index < input.start + input.chunk.byteLength; index += 1) {
      current.covered[index] = true;
    }
    current.ranges.push({
      start: input.start,
      end: input.start + input.chunk.byteLength - 1
    });
    this.pending.set(key, current);
    const complete = current.covered.every(Boolean);
    if (complete) {
      await this.putBlob(input.contentSha256, current.bytes);
      this.pending.delete(key);
    }
    return { receivedRanges: current.ranges, complete };
  }

  async deleteSession(sessionId: string): Promise<void> {
    for (const key of this.pending.keys()) {
      if (key.startsWith(sessionId + "\0")) {
        this.pending.delete(key);
      }
    }
  }
}
