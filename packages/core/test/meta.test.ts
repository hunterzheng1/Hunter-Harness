import { describe, expect, it } from "vitest";

import type { SourceFile } from "@hunter-harness/contracts";

import { SkillEntryError } from "../src/skill/errors.js";
import { deriveSlug } from "../src/skill/meta.js";

describe("deriveSlug", () => {
  it("UT-016 derives slug from frontmatter name", () => {
    const files: SourceFile[] = [{ path: "SKILL.md", content: "---\nname: harness-x\ndescription: d\n---\nbody" }];
    expect(deriveSlug(files, "claude-code")).toBe("harness-x");
  });

  it("UT-017 throws FRONTMATTER_INVALID when name missing", () => {
    const files: SourceFile[] = [{ path: "SKILL.md", content: "---\ndescription: d\n---\nbody" }];
    expect(() => deriveSlug(files, "claude-code")).toThrow(SkillEntryError);
    try {
      deriveSlug(files, "claude-code");
    } catch (error) {
      expect((error as SkillEntryError).code).toBe("FRONTMATTER_INVALID");
    }
  });

  it("U-11 deriveSlug returns name without harness- prefix", () => {
    const files: SourceFile[] = [{ path: "SKILL.md", content: "---\nname: my-skill\ndescription: d\n---\nbody" }];
    expect(deriveSlug(files, "claude-code")).toBe("my-skill");
  });
});
