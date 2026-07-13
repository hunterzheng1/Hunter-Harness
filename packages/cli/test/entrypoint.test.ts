import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isDirectCliEntrypoint } from "../src/bin.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const junctionBin = join(repoRoot, "node_modules", "hunter-harness", "dist", "bin.js");

describe("CLI entrypoint", () => {
  it("treats workspace junction argv as direct entry", () => {
    const real = realpathSync(junctionBin);
    // Node ESM: import.meta.url 是实路径，argv 可能仍是 junction 路径
    expect(isDirectCliEntrypoint(junctionBin, pathToFileURL(real).href)).toBe(true);
    expect(isDirectCliEntrypoint(real, pathToFileURL(real).href)).toBe(true);
  });

  it("runs --help when invoked through node_modules junction", async () => {
    try {
      await access(junctionBin);
    } catch {
      return;
    }
    const result = spawnSync(process.execPath, [junctionBin, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env
    });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain("Usage: hunter-harness");
  });
});
