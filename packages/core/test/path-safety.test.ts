import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertNoCaseCollisions,
  assertNoSymlinks,
  assertSameVolume,
  normalizeManagedPath
} from "../src/fs/path-safety.js";

describe("managed path safety", () => {
  it.each([
    "../secret",
    "rules/../../secret",
    "/etc/passwd",
    "C:/Users/secret",
    "C:\\Users\\secret",
    "foo/CON.txt",
    "foo/bad?.md",
    "foo/trailing. ",
    "a".repeat(241)
  ])("rejects unsafe path %s", (path) => {
    expect(() => normalizeManagedPath(path)).toThrow();
  });

  it("normalizes safe project-relative paths", () => {
    expect(normalizeManagedPath("./.claude//rules/harness.md"))
      .toBe(".claude/rules/harness.md");
  });

  it("rejects case-insensitive collisions", () => {
    expect(() => assertNoCaseCollisions(["Rules/A.md", "rules/a.md"]))
      .toThrow(/case/i);
  });

  it("rejects cross-volume staging", () => {
    expect(() => assertSameVolume("C:/project", "D:/stage")).toThrow(/volume/i);
  });

  it("rejects symbolic-link path components", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-path-"));
    const target = join(root, "target");
    await mkdir(target);
    await symlink(target, join(root, "linked"), "junction");

    await expect(assertNoSymlinks(root, "linked/file.md")).rejects.toThrow(/symbolic/i);
  });
});
