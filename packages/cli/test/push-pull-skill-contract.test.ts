import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CLI_CAPABILITIES } from "../src/workflow-data/compatibility.js";

describe("Stage 03 Push/Pull Skill contract", () => {
  it("publishes both Skills with capabilities (production RemoteSync transport 已就绪)", async () => {
    const policy = JSON.parse(await readFile(
      join(process.cwd(), "harness", "contracts", "workflow-policy.json"), "utf8"
    )) as { skills: Record<string, { capabilities: string[]; allowedInteractions: string[] }> };
    // 03 收尾（0.2.77）：skill 层补齐后，policy 必须登记两个 skill 与各自能力
    expect(policy.skills["harness-push"]).toBeDefined();
    expect(policy.skills["harness-pull"]).toBeDefined();
    expect(policy.skills["harness-push"].capabilities).toContain("remote-sync-push@1");
    expect(policy.skills["harness-pull"].capabilities).toContain("remote-sync-pull@1");
    expect(CLI_CAPABILITIES).toEqual(expect.arrayContaining([
      "remote-sync-push@1", "remote-sync-pull@1"
    ]));
    const family = JSON.parse(await readFile(join(
      process.cwd(), "packages", "workflow-data-harness", "hunter-workflow-family.json"
    ), "utf8")) as { capabilities: string[] };
    expect(family.capabilities).toEqual(expect.arrayContaining([
      "remote-sync-push@1", "remote-sync-pull@1"
    ]));
    for (const profile of ["general", "java"]) {
      for (const agent of ["claude-code", "codebuddy", "codex", "cursor"]) {
        for (const name of ["harness-push", "harness-pull"]) {
          await access(join(
            process.cwd(), "packages", "workflow-data-harness", "harness", "bundles",
            profile, agent, name, "SKILL.md"
          ));
        }
      }
    }
  });
});
