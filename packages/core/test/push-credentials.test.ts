import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CREDENTIALS_GITIGNORE_LINES,
  ensureCredentialsGitignore,
  mergeLocalCredentials,
  readLocalCredentials,
  resolvePushAuth,
  writeLocalCredentials
} from "../src/push/credentials.js";

describe("push credentials.local", () => {
  it("reads and writes credentials.local.yaml", async () => {
    const root = await mkdtemp(join(tmpdir(), "hh-cred-"));
    await mkdir(join(root, ".harness"), { recursive: true });
    await writeLocalCredentials(root, {
      token: "local-token",
      server_url: "https://server.example.test"
    });
    expect(await readLocalCredentials(root)).toEqual({
      token: "local-token",
      server_url: "https://server.example.test"
    });
  });

  it("prefers env token over credentials.local", () => {
    const resolved = resolvePushAuth({
      tokenEnv: "TEST_TOKEN",
      env: { TEST_TOKEN: "env-token" },
      local: { token: "local-token", server_url: "https://local.example.test" },
      projectUrl: "https://project.example.test",
      projectTokenEnv: "TEST_TOKEN"
    });
    expect(resolved).toEqual({
      serverUrl: "https://local.example.test",
      token: "env-token"
    });
  });

  it("uses credentials.local when env token is unset", () => {
    const resolved = resolvePushAuth({
      env: {},
      local: { token: "local-token", server_url: "https://local.example.test" },
      projectUrl: null,
      projectTokenEnv: "HUNTER_HARNESS_TOKEN"
    });
    expect(resolved).toEqual({
      serverUrl: "https://local.example.test",
      token: "local-token"
    });
  });

  it("returns TOKEN_INVALID when no token is available", () => {
    expect(resolvePushAuth({
      env: {},
      local: null,
      projectUrl: "https://project.example.test",
      projectTokenEnv: "HUNTER_HARNESS_TOKEN"
    })).toEqual({ code: "TOKEN_INVALID" });
  });

  it("ensures credentials paths are gitignored", async () => {
    const root = await mkdtemp(join(tmpdir(), "hh-gitignore-"));
    await ensureCredentialsGitignore(root);
    const content = await readFile(join(root, ".gitignore"), "utf8");
    for (const line of CREDENTIALS_GITIGNORE_LINES) {
      expect(content).toContain(line);
    }
  });

  it("rejects non-HTTPS server_url on write", async () => {
    const root = await mkdtemp(join(tmpdir(), "hh-cred-https-"));
    await mkdir(join(root, ".harness"), { recursive: true });
    await expect(writeLocalCredentials(root, {
      token: "local-token",
      server_url: "http://insecure.example.test"
    })).rejects.toThrow(/HTTPS/);
  });

  it("mergeLocalCredentials preserves existing fields", () => {
    expect(mergeLocalCredentials(
      { server_url: "https://stored.example.test" },
      { token: "new-token" }
    )).toEqual({
      server_url: "https://stored.example.test",
      token: "new-token"
    });
  });
});
