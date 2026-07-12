import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InitConfigurationError,
  parseAgentsInput,
  resolveInitConfig
} from "../src/config/init-config.js";

describe("parseAgentsInput", () => {
  it.each([
    ["", ["claude-code"]],
    ["1", ["claude-code"]],
    ["1,2,4", ["claude-code", "codex", "codebuddy"]],
    ["claude-code,codex,codebuddy", ["claude-code", "codex", "codebuddy"]],
    ["all", ["claude-code", "codex", "cursor", "codebuddy"]],
    ["4,1,4", ["claude-code", "codebuddy"]],
    [" 2 , 3 ", ["codex", "cursor"]]
  ])("parses %j", (input, expected) => {
    expect(parseAgentsInput(input)).toEqual(expected);
  });

  it("rejects any unknown token entirely", () => {
    expect(() => parseAgentsInput("codex,5")).toThrow(InitConfigurationError);
    expect(() => parseAgentsInput("gpt")).toThrow(InitConfigurationError);
    try {
      parseAgentsInput("gpt");
    } catch (error) {
      expect(error).toBeInstanceOf(InitConfigurationError);
      expect((error as InitConfigurationError).code).toBe("AGENT_UNSUPPORTED");
      expect((error as InitConfigurationError).exitCode).toBe(3);
    }
  });
});

describe("resolveInitConfig agents/legacy/surface", () => {
  async function writeConfig(root: string, body: unknown): Promise<string> {
    const path = join(root, "harness.init.json");
    await writeFile(path, JSON.stringify(body));
    return path;
  }

  it("legacy adapter=claude-code normalizes with warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    const warnings: string[] = [];
    const config = await resolveInitConfig(
      root,
      { config: await writeConfig(root, { adapter: "claude-code", profile: "general" }) },
      {},
      warnings
    );
    expect(config.agents).toEqual(["claude-code"]);
    expect(warnings.some((w) => /deprecat/i.test(w))).toBe(true);
  });

  it("legacy adapter with non-claude value exits 3 AGENT_UNSUPPORTED", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    await expect(resolveInitConfig(
      root,
      { config: await writeConfig(root, { adapter: "cursor", profile: "general" }) }
    )).rejects.toMatchObject({
      code: "AGENT_UNSUPPORTED",
      exitCode: 3
    });
  });

  it("agents and adapter in the same JSON exits 3 AGENT_OPTIONS_CONFLICT", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    await expect(resolveInitConfig(
      root,
      {
        config: await writeConfig(root, {
          agents: ["codex"],
          adapter: "claude-code",
          profile: "general"
        })
      }
    )).rejects.toMatchObject({
      code: "AGENT_OPTIONS_CONFLICT",
      exitCode: 3
    });
  });

  it("surface without codebuddy exits 3 CODEBUDDY_SURFACE_UNUSED", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    await expect(resolveInitConfig(
      root,
      {
        config: await writeConfig(root, {
          agents: ["codex"],
          profile: "general",
          codebuddy_surface: "ide"
        })
      }
    )).rejects.toMatchObject({
      code: "CODEBUDDY_SURFACE_UNUSED",
      exitCode: 3
    });

    await expect(resolveInitConfig(root, {
      agents: "codex",
      profile: "general",
      codebuddySurface: "ide"
    })).rejects.toMatchObject({
      code: "CODEBUDDY_SURFACE_UNUSED",
      exitCode: 3
    });
  });

  it("config file agents take precedence over --agents flag", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    const config = await resolveInitConfig(root, {
      config: await writeConfig(root, { agents: ["codex"], profile: "java" }),
      agents: "cursor",
      profile: "general"
    });
    expect(config.agents).toEqual(["codex"]);
    expect(config.profile).toBe("java");
  });

  it("non-interactive without agents keeps claude-code default", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    const config = await resolveInitConfig(root, { profile: "general" });
    expect(config.agents).toEqual(["claude-code"]);
    expect(config.codebuddy_surface).toBe("both");
  });

  it("codebuddy with surface both is accepted", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-init-cfg-"));
    const config = await resolveInitConfig(root, {
      agents: "codebuddy",
      profile: "general",
      codebuddySurface: "both"
    });
    expect(config.agents).toEqual(["codebuddy"]);
    expect(config.codebuddy_surface).toBe("both");
  });
});
