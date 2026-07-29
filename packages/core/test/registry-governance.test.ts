import { describe, expect, it } from "vitest";

import {
  assessRegistryCapacity,
  planRegistryCleanup
} from "../src/platform/registry-governance.js";

describe("container registry governance", () => {
  it("blocks a build before it would exceed the version quota", () => {
    expect(assessRegistryCapacity({
      currentVersionCount: 99,
      plannedAdditions: 2,
      quota: 100,
      warningRatio: 0.9
    })).toMatchObject({
      status: "BLOCKED",
      reasonCode: "REGISTRY_VERSION_QUOTA_FULL",
      remainingBefore: 1,
      remainingAfter: -1
    });
  });

  it("protects every tag sharing a protected digest and emits a dry-run receipt", () => {
    const plan = planRegistryCleanup({
      versions: [
        {
          tag: "prod",
          digest: "sha256:protected",
          createdAt: "2026-07-29T00:00:00Z"
        },
        {
          tag: "alias-of-prod",
          digest: "sha256:protected",
          createdAt: "2026-07-01T00:00:00Z"
        },
        {
          tag: "old-a",
          digest: "sha256:old-a",
          createdAt: "2026-06-01T00:00:00Z"
        },
        {
          tag: "old-b",
          digest: "sha256:old-b",
          createdAt: "2026-06-02T00:00:00Z"
        }
      ],
      protectedTags: ["prod"],
      protectedDigests: [],
      retainVersionCount: 3
    });

    expect(plan.schemaVersion).toBe(1);
    expect(plan.dryRun).toBe(true);
    expect(plan.deleteTags).toEqual(["old-a"]);
    expect(plan.protectedTags).toEqual(["alias-of-prod", "prod"]);
    expect(plan.beforeVersionCount).toBe(4);
    expect(plan.afterVersionCount).toBe(3);
    expect(plan.protectedDigests).toEqual(["sha256:protected"]);
  });

  it("never deletes more versions than required and orders candidates deterministically", () => {
    const plan = planRegistryCleanup({
      versions: [
        { tag: "z", digest: "sha256:z", createdAt: "2026-01-01T00:00:00Z" },
        { tag: "a", digest: "sha256:a", createdAt: "2026-01-01T00:00:00Z" },
        { tag: "new", digest: "sha256:new", createdAt: "2026-07-29T00:00:00Z" }
      ],
      protectedTags: [],
      protectedDigests: [],
      retainVersionCount: 2
    });

    expect(plan.deleteTags).toEqual(["a"]);
    expect(plan.afterVersionCount).toBe(2);
  });
});
