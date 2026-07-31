import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractHunterHarnessCommands
} from "../../../scripts/skill-command-contract.mjs";

describe("packaged Skill command contract", () => {
  it("uses sync as the single entrypoint with its internal capability gate", async () => {
    const skill = await readFile(
      join(process.cwd(), "harness", "harness-sync", "SKILL.md"),
      "utf8"
    );
    const commands = extractHunterHarnessCommands(skill);

    expect(commands).toEqual(["sync"]);
  });

  it("deduplicates npx and direct CLI examples", () => {
    expect(extractHunterHarnessCommands([
      "npx hunter-harness capabilities --json",
      "hunter-harness sync --json",
      "npx hunter-harness sync --project . --json"
    ].join("\n"))).toEqual(["capabilities", "sync"]);
  });
});
