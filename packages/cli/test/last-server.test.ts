import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readLastServerUrl,
  resolveUserStateRoot,
  writeLastServerUrl
} from "../src/config/last-server.js";

describe("last-server user preference", () => {
  let root: string;
  const env: Record<string, string> = {};

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function freshRoot(): Promise<Record<string, string>> {
    root = await mkdtemp(join(tmpdir(), "hunter-last-server-"));
    env.HUNTER_HARNESS_USER_STATE_ROOT = root;
    return env;
  }

  it("resolves the state root from the env override", async () => {
    const e = await freshRoot();
    expect(resolveUserStateRoot(e)).toBe(root);
  });

  it("round-trips the last connected server url", async () => {
    const e = await freshRoot();
    await writeLastServerUrl("https://harness.hunter-z.com", e);
    await expect(readLastServerUrl(e)).resolves.toBe("https://harness.hunter-z.com");
  });

  it("returns undefined when nothing is stored or the file is corrupt", async () => {
    const e = await freshRoot();
    await expect(readLastServerUrl(e)).resolves.toBeUndefined();
    await writeFile(join(root, "last-server.json"), "{not json", "utf8");
    await expect(readLastServerUrl(e)).resolves.toBeUndefined();
    await writeFile(join(root, "last-server.json"), JSON.stringify({ server_url: "ftp://x" }), "utf8");
    await expect(readLastServerUrl(e)).resolves.toBeUndefined();
  });

  it("rejects insecure urls on write and never throws", async () => {
    const e = await freshRoot();
    await writeLastServerUrl("http://192.168.1.10:8080", e);
    await expect(readLastServerUrl(e)).resolves.toBeUndefined();
    // loopback http 是允许的（本机开发平台）
    await writeLastServerUrl("http://127.0.0.1:8787", e);
    await expect(readLastServerUrl(e)).resolves.toBe("http://127.0.0.1:8787");
  });
});
