import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composeArchiveProduction } from "../src/archive-production/compose.js";

describe("archive production composition (06B-3 W4)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "archive-compose-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("pushPullArchive fails closed when no queued record exists", async () => {
    const composition = composeArchiveProduction({
      projectRoot: root,
      publisher: { publishArchive: async () => ({}) },
      resolveSource: async () => ({
        project_id: "prj_c", branch_name: "main", commit_sha: "abc", client_id: "cli"
      })
    });
    await expect(composition.pushPullArchive("no-such-change"))
      .rejects.toThrow("PUSH_PULL_ARCHIVE_UNAVAILABLE");
  });
});
