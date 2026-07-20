import { describe, expect, it } from "vitest";

import { AGENT_DESCRIPTORS, INSTALLABLE_AGENTS } from "../src/index.js";

describe("native skill agent destinations", () => {
  it("uses the native project skill roots for all supported agents", () => {
    expect(AGENT_DESCRIPTORS["claude-code"].installTarget("demo")).toBe(".claude/skills/demo/");
    expect(AGENT_DESCRIPTORS.codex.installTarget("demo")).toBe(".agents/skills/demo/");
    expect(AGENT_DESCRIPTORS.cursor.installTarget("demo")).toBe(".cursor/skills/demo/");
    expect(Reflect.get(AGENT_DESCRIPTORS, "codebuddy")?.installTarget("demo"))
      .toBe(".codebuddy/skills/demo/");
  });

  it("exposes only the four native agents as new install targets", () => {
    expect(INSTALLABLE_AGENTS).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "codebuddy"
    ]);
  });
});
