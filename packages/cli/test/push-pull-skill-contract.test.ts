import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CLI_CAPABILITIES } from "../src/workflow-data/compatibility.js";

describe("Stage 03 Push/Pull Skill contract", () => {
  it("withholds both Skills and capabilities until a production RemoteSync transport exists", async () => {
    const policy = JSON.parse(await readFile(
      join(process.cwd(), "harness", "contracts", "workflow-policy.json"), "utf8"
    )) as { skills: Record<string, unknown>; interactionWhitelist: Record<string, string[]> };

    expect(policy.skills["harness-push"]).toBeUndefined();
    expect(policy.skills["harness-pull"]).toBeUndefined();
    expect(policy.interactionWhitelist["harness-push"]).toBeUndefined();
    expect(policy.interactionWhitelist["harness-pull"]).toBeUndefined();
    expect(CLI_CAPABILITIES).not.toEqual(expect.arrayContaining([
      "remote-sync-push@1", "remote-sync-pull@1"
    ]));
    const family = JSON.parse(await readFile(join(
      process.cwd(), "packages", "workflow-data-harness", "hunter-workflow-family.json"
    ), "utf8")) as { capabilities: string[] };
    expect(family.capabilities).not.toEqual(expect.arrayContaining([
      "remote-sync-push@1", "remote-sync-pull@1"
    ]));
    for (const profile of ["general", "java"]) {
      for (const agent of ["claude-code", "codebuddy", "codex", "cursor"]) {
        for (const name of ["harness-push", "harness-pull"]) {
          await expect(access(join(
            process.cwd(), "packages", "workflow-data-harness", "harness", "bundles",
            profile, agent, name, "SKILL.md"
          ))).rejects.toThrow();
        }
      }
    }
  });
});
