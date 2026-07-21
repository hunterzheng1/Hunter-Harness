import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Import the closure-check function directly. We test the pure function rather
// than the full sync pipeline to keep the test fast and deterministic.
import { assertSupportFilesPresent } from "../../../scripts/sync-harness.mjs";

async function makeBundle(root: string, skill: string, skillMd: string): Promise<string> {
  const skillDir = join(root, skill);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), skillMd, "utf8");
  return skillDir;
}

describe("sync-harness assertSupportFilesPresent — retro §5.17", () => {
  it("passes when all Read `xxx.md` refs resolve", async () => {
    const root = await mkdtemp(join(tmpdir(), "closure-ok-"));
    try {
      await makeBundle(
        root,
        "harness-demo",
        "---\nname: harness-demo\ndescription: demo\n---\n\n# Demo\n\nRead `reference.md` for details.\n"
      );
      await writeFile(join(root, "harness-demo", "reference.md"), "# Reference\n", "utf8");
      await expect(assertSupportFilesPresent(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails on dangling [[shared/xxx.md|...]] wiki link", async () => {
    const root = await mkdtemp(join(tmpdir(), "closure-wiki-"));
    try {
      await makeBundle(
        root,
        "harness-demo",
        "---\nname: harness-demo\ndescription: demo\n---\n\n# Demo\n\nSee [[shared/worktree-gate.md|worktree-gate]] for details.\n"
      );
      // shared/worktree-gate.md is NOT present in the bundle
      await expect(assertSupportFilesPresent(root)).rejects.toThrow(/SUPPORT_FILE_MISSING|DANGLING_SHARED_REF/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails on unexpanded <!-- @include shared/xxx.md --> placeholder", async () => {
    const root = await mkdtemp(join(tmpdir(), "closure-include-"));
    try {
      await makeBundle(
        root,
        "harness-demo",
        "---\nname: harness-demo\ndescription: demo\n---\n\n# Demo\n\n<!-- @include shared/p0-trust.md -->\n"
      );
      // shared/p0-trust.md is NOT present and @include was not expanded
      await expect(assertSupportFilesPresent(root)).rejects.toThrow(/SUPPORT_FILE_MISSING|DANGLING_SHARED_REF/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes when shared file referenced by wiki link is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "closure-shared-ok-"));
    try {
      await makeBundle(
        root,
        "harness-demo",
        "---\nname: harness-demo\ndescription: demo\n---\n\n# Demo\n\nSee [[shared/worktree-gate.md|worktree-gate]].\n"
      );
      await mkdir(join(root, "shared"), { recursive: true });
      await writeFile(join(root, "shared", "worktree-gate.md"), "# Worktree Gate\n", "utf8");
      await expect(assertSupportFilesPresent(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
