import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InitConfigurationError,
  resolveInitConfig
} from "../src/config/init-config.js";

describe("resolveInitConfig (v1.0)", () => {
  async function writeConfig(root: string, body: unknown): Promise<string> {
    const path = join(root, "harness.init.json");
    await writeFile(path, JSON.stringify(body));
    return path;
  }

  it("strips retired v0 fields with a deprecation warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    const warnings: string[] = [];
    const config = await resolveInitConfig(
      root,
      {
        config: await writeConfig(root, {
          agents: ["codex"],
          adapter: "claude-code",
          profile: "java",
          codebuddy_surface: "ide",
          server_url: "https://platform.example.test"
        })
      },
      warnings
    );
    expect(config.server_url).toBe("https://platform.example.test");
    expect(warnings.filter((w) => w.startsWith("DEPRECATION:"))).toHaveLength(4);
  });

  it("keeps a clean config warning-free", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    const warnings: string[] = [];
    const config = await resolveInitConfig(
      root,
      { config: await writeConfig(root, { server_url: "https://platform.example.test" }) },
      warnings
    );
    expect(config.server_url).toBe("https://platform.example.test");
    expect(warnings).toEqual([]);
  });

  it("defaults to a local-only config without flags or file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    const config = await resolveInitConfig(root, {});
    expect(config.server_url).toBeNull();
    expect(config.token_env).toBe("HUNTER_HARNESS_TOKEN");
  });

  it("prefers the config file over flags for server_url", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    const config = await resolveInitConfig(root, {
      config: await writeConfig(root, { server_url: "https://file.example.test" }),
      serverUrl: "https://flag.example.test"
    });
    expect(config.server_url).toBe("https://file.example.test");
  });

  it("rejects a missing config file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    await expect(resolveInitConfig(root, { config: "nope.json" }))
      .rejects.toMatchObject({ message: expect.stringContaining("INIT_CONFIG_MISSING") });
    await expect(resolveInitConfig(root, { config: "nope.json" }))
      .rejects.toBeInstanceOf(InitConfigurationError);
  });

  it("rejects invalid JSON and non-object shapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    const badJson = join(root, "bad.json");
    await writeFile(badJson, "{not json");
    await expect(resolveInitConfig(root, { config: badJson }))
      .rejects.toMatchObject({ message: expect.stringContaining("INIT_CONFIG_INVALID_JSON") });

    const arrayConfig = await writeConfig(root, [1, 2]);
    await expect(resolveInitConfig(root, { config: arrayConfig }))
      .rejects.toMatchObject({ message: expect.stringContaining("INIT_CONFIG_INVALID_SHAPE") });
  });
});
