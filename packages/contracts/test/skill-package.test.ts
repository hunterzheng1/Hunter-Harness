import { describe, expect, it } from "vitest";

import {
  authorSkillBundleManifestSchema,
  skillPackageManifestV3Schema
} from "../src/index.js";

describe("skill package contracts", () => {
  it("accepts a skill plus native subagent variants", () => {
    const manifest = authorSkillBundleManifestSchema.parse({
      apiVersion: "hunter-harness/v1",
      kind: "SkillBundle",
      components: [{ role: "skill", source: "." }, {
        role: "subagent",
        source: ".",
        name: "reviewer",
        variants: {
          "claude-code": "agents/reviewer.md",
          codex: "agents/reviewer.toml"
        }
      }]
    });
    expect(manifest.components).toHaveLength(2);
  });

  it("rejects traversal and undeclared high-impact component roles", () => {
    expect(authorSkillBundleManifestSchema.safeParse({
      apiVersion: "hunter-harness/v1",
      kind: "SkillBundle",
      components: [{ role: "skill", source: "../outside" }]
    }).success).toBe(false);
    expect(authorSkillBundleManifestSchema.safeParse({
      apiVersion: "hunter-harness/v1",
      kind: "SkillBundle",
      components: [{ role: "hook", source: "." }]
    }).success).toBe(false);
  });

  it("requires the four legacy variants in an npm manifest v3 and accepts an optional pi variant", () => {
    const baseVariant = {
      status: "ready" as const,
      adapterVersion: "1",
      buildHash: null,
      components: ["skill"]
    };
    const legacyOnly = {
      schema_version: 3,
      slug: "demo",
      version: "1.0.0",
      files: [{ path: "skill/SKILL.md", sha256: "sha256:" + "a".repeat(64), size: 10 }],
      components: [{ role: "skill", source: "." }],
      variants: {
        "claude-code": baseVariant,
        codex: baseVariant,
        cursor: baseVariant,
        codebuddy: baseVariant
      }
    };
    const parsedLegacy = skillPackageManifestV3Schema.parse(legacyOnly);
    expect(Object.keys(parsedLegacy.variants)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "codebuddy"
    ]);

    const parsedWithPi = skillPackageManifestV3Schema.parse({
      ...legacyOnly,
      variants: { ...legacyOnly.variants, pi: baseVariant }
    });
    expect(parsedWithPi.variants.pi).toEqual(baseVariant);

    const missingLegacy = {
      ...legacyOnly,
      variants: { codex: baseVariant, cursor: baseVariant, codebuddy: baseVariant }
    };
    expect(skillPackageManifestV3Schema.safeParse(missingLegacy).success).toBe(false);
  });
});
