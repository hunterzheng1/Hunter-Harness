import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Bytes } from "@hunter-harness/core";
import { describe, expect, it } from "vitest";

import { LocalArtifactStorage } from "../src/storage/local.js";

describe("local artifact storage", () => {
  it("assembles resumable chunks and verifies content-addressed blobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-artifacts-"));
    const storage = new LocalArtifactStorage(root);
    const content = new TextEncoder().encode("abcdef");
    const hash = sha256Bytes(content);

    const second = await storage.writeSessionChunk({
      sessionId: "ups_test",
      contentSha256: hash,
      start: 3,
      total: 6,
      chunk: content.slice(3)
    });
    expect(second.complete).toBe(false);
    expect(await storage.hasBlob(hash)).toBe(false);

    const first = await storage.writeSessionChunk({
      sessionId: "ups_test",
      contentSha256: hash,
      start: 0,
      total: 6,
      chunk: content.slice(0, 3)
    });
    expect(first.complete).toBe(true);
    expect([...await storage.getBlob(hash)]).toEqual([...content]);
    await expect(storage.putBlob(hash, new TextEncoder().encode("wrong"))).rejects.toThrow(
      /hash/i
    );
  });
});
