import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";

import type { SourceFile } from "@hunter-harness/contracts";

import { WorkflowFamilyStore } from "../src/registry/workflow-family-store.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const generalFiles: SourceFile[] = [
  { path: ".harness-build.json", content: '{"profile":"general","version":"1.0.0"}\n' },
  { path: "manifests/claude-code.json", content: '{"schema_version":1}\n' }
];

const javaFiles: SourceFile[] = [
  { path: ".harness-build.json", content: '{"profile":"java","version":"1.0.0"}\n' },
  { path: "manifests/claude-code.json", content: '{"schema_version":1}\n' }
];

function newStore(): WorkflowFamilyStore {
  const store = new WorkflowFamilyStore({
    storage: new MemoryArtifactStorage(),
    families: new Map(),
    drafts: new Map(),
    persist: async () => {},
    compilerVersion: () => "1.0.0"
  });
  store.createFamily({
    slug: "harness",
    displayName: "Harness",
    description: "Default harness workflow family",
    tags: [],
    required_profiles: ["general", "java"]
  });
  return store;
}

describe("WorkflowFamilyStore", () => {
  it("uploads per-profile drafts and publishes one family version", async () => {
    const store = newStore();
    await store.uploadProfileDraft({ slug: "harness", profile: "general", files: generalFiles, actorId: "actor" });
    await store.uploadProfileDraft({ slug: "harness", profile: "java", files: javaFiles, actorId: "actor" });
    const checks = await store.runFamilyChecks({ slug: "harness", checkedAt: "2026-07-12T00:00:00Z" });
    expect(checks.summary.red).toBe(0);
    const version = await store.publishFamily("harness", { version: "1.0.0", releaseNote: "init", actorId: "actor" });
    expect(version.version).toBe("1.0.0");
    expect(version.profiles).toHaveLength(2);
    expect(store.getFamily("harness").latest_version).toBe("1.0.0");
  });

  it("flags missing required profile during checks", async () => {
    const store = newStore();
    await store.uploadProfileDraft({ slug: "harness", profile: "general", files: generalFiles, actorId: "actor" });
    const checks = await store.runFamilyChecks({ slug: "harness", checkedAt: "2026-07-12T00:00:00Z" });
    expect(checks.items.some((item) => item.id === "PROFILE_MISSING_java")).toBe(true);
    expect(checks.summary.red).toBeGreaterThan(0);
  });

  it("rejects publish when required profile is missing", async () => {
    const store = newStore();
    await store.uploadProfileDraft({ slug: "harness", profile: "general", files: generalFiles, actorId: "actor" });
    await expect(store.publishFamily("harness", { version: "1.0.0", actorId: "actor" }))
      .rejects.toMatchObject({ code: "WORKFLOW_PROFILE_INCOMPLETE" });
  });

  it("stores downloadable profile artifact zip", async () => {
    const storage = new MemoryArtifactStorage();
    const store = new WorkflowFamilyStore({
      storage,
      families: new Map(),
      drafts: new Map(),
      persist: async () => {},
      compilerVersion: () => "1.0.0"
    });
    store.createFamily({
      slug: "harness",
      displayName: "Harness",
      description: "Default harness workflow family",
      tags: [],
      required_profiles: ["general"]
    });
    await store.uploadProfileDraft({ slug: "harness", profile: "general", files: generalFiles, actorId: "actor" });
    const version = await store.publishFamily("harness", { version: "1.0.0", actorId: "actor" });
    const bytes = await store.getProfileArtifactBytes("harness", "general");
    const zip = new AdmZip(bytes);
    expect(zip.getEntry("hunter-workflow-family.json")).not.toBeNull();
    expect(version.artifacts[0]?.profile).toBe("general");
  });
});
