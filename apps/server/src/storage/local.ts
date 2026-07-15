import { mkdir, open, readFile, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { atomicWriteFile, atomicWriteJson, sha256Bytes } from "@hunter-harness/core";

import { ServerDomainError } from "../repositories/interfaces.js";
import type { ArtifactStorage, ChunkWriteResult, QuarantinedBlob } from "./interface.js";

function hashName(hash: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
    throw new ServerDomainError(422, "ARTIFACT_HASH_MISMATCH", "invalid blob hash");
  }
  return hash.slice("sha256:".length);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export class LocalArtifactStorage implements ArtifactStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private blobPath(hash: string): string {
    return join(this.root, "blobs", hashName(hash));
  }

  private quarantinePath(hash: string): string {
    return join(this.root, "quarantine", hashName(hash));
  }

  async hasBlob(contentSha256: string): Promise<boolean> {
    return exists(this.blobPath(contentSha256));
  }

  async getBlob(contentSha256: string): Promise<Uint8Array> {
    try {
      return await readFile(this.blobPath(contentSha256));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        try {
          return await readFile(this.quarantinePath(contentSha256));
        } catch (quarantineError) {
          if (quarantineError instanceof Error && "code" in quarantineError && quarantineError.code === "ENOENT") {
            throw new ServerDomainError(404, "ARTIFACT_NOT_FOUND", "artifact blob not found");
          }
          throw quarantineError;
        }
      }
      throw error;
    }
  }

  async putBlob(contentSha256: string, content: Uint8Array): Promise<void> {
    if (sha256Bytes(content) !== contentSha256) {
      throw new ServerDomainError(422, "ARTIFACT_HASH_MISMATCH", "blob hash mismatch");
    }
    const path = this.blobPath(contentSha256);
    if (!await exists(path)) {
      const quarantinedPath = this.quarantinePath(contentSha256);
      if (await exists(quarantinedPath)) {
        await mkdir(dirname(path), { recursive: true });
        try {
          await rename(quarantinedPath, path);
          return;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      await atomicWriteFile(path, content);
    }
  }

  async quarantineBlob(contentSha256: string, quarantinedAt: string): Promise<boolean> {
    const source = this.blobPath(contentSha256);
    const target = this.quarantinePath(contentSha256);
    if (!await exists(source) || await exists(target)) return false;
    await mkdir(dirname(target), { recursive: true });
    try {
      await rename(source, target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
    const date = new Date(quarantinedAt);
    await utimes(target, date, date);
    return true;
  }

  async listQuarantinedBlobs(): Promise<QuarantinedBlob[]> {
    const root = join(this.root, "quarantine");
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const items = await Promise.all(names
      .filter((name) => /^[a-f0-9]{64}$/.test(name))
      .map(async (name) => ({
        contentSha256: `sha256:${name}`,
        quarantinedAt: (await stat(join(root, name))).mtime.toISOString()
      })));
    return items;
  }

  async restoreQuarantinedBlob(contentSha256: string): Promise<void> {
    const source = this.quarantinePath(contentSha256);
    if (!await exists(source)) return;
    const target = this.blobPath(contentSha256);
    if (await exists(target)) {
      await rm(source, { force: true });
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    try {
      await rename(source, target);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  async deleteQuarantinedBlob(contentSha256: string): Promise<void> {
    await rm(this.quarantinePath(contentSha256), { force: true });
  }

  async writeSessionChunk(input: {
    sessionId: string;
    contentSha256: string;
    start: number;
    total: number;
    chunk: Uint8Array;
  }): Promise<ChunkWriteResult> {
    const sessionRoot = join(this.root, "sessions", input.sessionId);
    const pendingPath = join(sessionRoot, hashName(input.contentSha256) + ".part");
    const rangesPath = pendingPath + ".ranges.json";
    await mkdir(dirname(pendingPath), { recursive: true });
    const handle = await open(pendingPath, await exists(pendingPath) ? "r+" : "w+");
    try {
      if ((await handle.stat()).size === 0) {
        await handle.truncate(input.total);
      }
      if ((await handle.stat()).size !== input.total) {
        throw new ServerDomainError(422, "UPLOAD_RANGE_INVALID", "upload total changed");
      }
      await handle.write(input.chunk, 0, input.chunk.byteLength, input.start);
      await handle.sync();
    } finally {
      await handle.close();
    }
    let ranges: Array<{ start: number; end: number }> = [];
    if (await exists(rangesPath)) {
      ranges = JSON.parse(await readFile(rangesPath, "utf8")) as typeof ranges;
    }
    ranges = mergeRanges([...ranges, {
      start: input.start,
      end: input.start + input.chunk.byteLength - 1
    }]);
    await atomicWriteJson(rangesPath, ranges);
    const complete = ranges.length === 1 && ranges[0]?.start === 0 &&
      ranges[0]?.end === input.total - 1;
    if (complete) {
      const content = await readFile(pendingPath);
      await this.putBlob(input.contentSha256, content);
      await Promise.all([
        rm(pendingPath, { force: true }),
        rm(rangesPath, { force: true })
      ]);
    }
    return { receivedRanges: ranges, complete };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await rm(join(this.root, "sessions", sessionId), { recursive: true, force: true });
  }
}
