import { describe, expect, it } from "vitest";

import { planSyncPush } from "../src/commands/sync.js";

describe("planSyncPush", () => {
  it("does not push unless --push is requested", () => {
    expect(planSyncPush({}, 0)).toEqual({ push: false });
    expect(planSyncPush({ push: undefined }, 0)).toEqual({ push: false });
  });

  it("pushes the配置类 scopes by default after a clean sync", () => {
    expect(planSyncPush({ push: true }, 0)).toEqual({
      push: true,
      scopes: "config,rules,architecture,instructions"
    });
  });

  it("still pushes on WARN because a stale map is the common case, not a broken project", () => {
    expect(planSyncPush({ push: true }, 5)).toEqual({
      push: true,
      scopes: "config,rules,architecture,instructions"
    });
  });

  it("refuses to push when the project state is blocked or failed", () => {
    expect(planSyncPush({ push: true }, 7)).toEqual({
      push: false,
      reasonCode: "SYNC_PUSH_SKIPPED_BLOCKED"
    });
    expect(planSyncPush({ push: true }, 1)).toEqual({
      push: false,
      reasonCode: "SYNC_PUSH_SKIPPED_BLOCKED"
    });
  });

  it("keeps --check and --dry-run purely read-only", () => {
    expect(planSyncPush({ push: true, check: true }, 0)).toEqual({
      push: false,
      reasonCode: "SYNC_PUSH_SKIPPED_READ_ONLY"
    });
    expect(planSyncPush({ push: true, dryRun: true }, 0)).toEqual({
      push: false,
      reasonCode: "SYNC_PUSH_SKIPPED_READ_ONLY"
    });
  });

  it("honours an explicit scope list", () => {
    expect(planSyncPush({ push: "config,rules" }, 0)).toEqual({
      push: true,
      scopes: "config,rules"
    });
    expect(planSyncPush({ push: "all" }, 0)).toEqual({ push: true, scopes: "all" });
  });

  it("rejects a scope value that is not a usable list", () => {
    for (const value of ["", "   ", ","]) {
      expect(planSyncPush({ push: value }, 0), value).toEqual({
        push: false,
        reasonCode: "SYNC_PUSH_SCOPE_INVALID"
      });
    }
  });
});
