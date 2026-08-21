import { describe, expect, it } from "vitest";

import {
  probeGitCapabilities,
  type GitExec
} from "../src/plan-evidence/git-probe.js";

function fakeExec(responses: Record<string, string | Error>): GitExec {
  return async (args) => {
    const key = args.join(" ");
    const value = responses[key];
    if (value === undefined) throw new Error(`unexpected git call: ${key}`);
    if (value instanceof Error) throw value;
    return value;
  };
}

describe("probeGitCapabilities", () => {
  it("detects a plain git repository with a remote", async () => {
    const probe = await probeGitCapabilities("/repo", fakeExec({
      "rev-parse --is-inside-work-tree": "true\n",
      "remote": "origin\n",
      "rev-parse --git-dir": ".git\n",
      "rev-parse --git-common-dir": ".git\n"
    }));
    expect(probe).toEqual({
      is_git: true, has_remote: true, uses_worktree: false, provenance: "probe"
    });
  });

  it("detects a linked worktree by git-dir differing from common-dir", async () => {
    const probe = await probeGitCapabilities("/repo/.worktrees/demo", fakeExec({
      "rev-parse --is-inside-work-tree": "true\n",
      "remote": "",
      "rev-parse --git-dir": "/repo/.git/worktrees/demo\n",
      "rev-parse --git-common-dir": "/repo/.git\n"
    }));
    expect(probe).toEqual({
      is_git: true, has_remote: false, uses_worktree: true, provenance: "probe"
    });
  });

  it("returns unavailable outside a git repository", async () => {
    const probe = await probeGitCapabilities("/elsewhere", fakeExec({
      "rev-parse --is-inside-work-tree": "false\n"
    }));
    expect(probe).toEqual({
      is_git: false, has_remote: false, uses_worktree: false, provenance: "unavailable"
    });
  });

  it("returns unavailable when git is not on PATH (exec throws)", async () => {
    const probe = await probeGitCapabilities("/repo", async () => {
      throw new Error("ENOENT: git not found");
    });
    expect(probe.is_git).toBe(false);
    expect(probe.provenance).toBe("unavailable");
  });

  it("returns unavailable when any probe command fails mid-sequence", async () => {
    const probe = await probeGitCapabilities("/repo", fakeExec({
      "rev-parse --is-inside-work-tree": "true\n",
      "remote": new Error("fatal: bad config")
    }));
    expect(probe).toEqual({
      is_git: false, has_remote: false, uses_worktree: false, provenance: "unavailable"
    });
  });
});
