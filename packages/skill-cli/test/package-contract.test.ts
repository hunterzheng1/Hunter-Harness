import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface SkillCliPackageJson {
  name?: string;
  bin?: Record<string, string>;
}

describe("@hunter-harness/skills package contract", () => {
  it("publishes the canonical package name with canonical and legacy executables", async () => {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as SkillCliPackageJson;

    expect(packageJson.name).toBe("@hunter-harness/skills");
    expect(packageJson.bin).toEqual({
      skills: "dist/bin.js",
      "hunter-harness-skill": "dist/bin.js"
    });
  });
});
