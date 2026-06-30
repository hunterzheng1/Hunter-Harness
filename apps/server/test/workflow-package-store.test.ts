import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";

import type { SourceFile } from "@hunter-harness/contracts";

import { WorkflowPackageStore } from "../src/registry/workflow-package-store.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const workflowYaml = `key: release-flow
name: Release Flow
description: End-to-end release workflow
profile: general
skills:
  - slug: harness-sync
    ref: "1.0.0"
agents:
  - path: agents/release.md
    ref: main
protocols: []
templates: []
execution_order:
  - harness-sync
strategy: sequential
`;

const files: SourceFile[] = [
  { path: "workflow.yaml", content: workflowYaml },
  { path: "agents/release.md", content: "# Release agent" }
];

function newStore(): WorkflowPackageStore {
  return new WorkflowPackageStore({
    storage: new MemoryArtifactStorage(),
    packages: new Map(),
    drafts: new Map(),
    persist: async () => {},
    compilerVersion: () => "1.0.0"
  });
}

describe("WorkflowPackageStore draft CRUD (UT-001~008, UT-014)", () => {
  it("uploadPackage parses workflow.yaml and builds draft (UT-001)", async () => {
    const store = newStore();
    const draft = await store.uploadPackage({ files, actorId: "actor" });
    expect(draft.key).toBe("release-flow");
    expect(draft.manifest.skills[0].slug).toBe("harness-sync");
    expect(draft.revision).toBe(1);
  });

  it("getPackageDraft returns draft (UT-002)", async () => {
    const store = newStore();
    await store.uploadPackage({ files, actorId: "actor" });
    const draft = store.getPackageDraft("release-flow");
    expect(draft?.key).toBe("release-flow");
  });

  it("getPackageDraft missing throws DRAFT_NOT_FOUND (UT-003)", () => {
    const store = newStore();
    expect(() => store.getPackageDraft("nope")).toThrow(expect.objectContaining({ code: "DRAFT_NOT_FOUND" }));
  });

  it("discardPackageDraft removes draft (UT-004)", async () => {
    const store = newStore();
    await store.uploadPackage({ files, actorId: "actor" });
    await store.discardPackageDraft("release-flow", 1);
    expect(() => store.getPackageDraft("release-flow")).toThrow(expect.objectContaining({ code: "DRAFT_NOT_FOUND" }));
  });

  it("runPackageChecks writes checks to draft (UT-005)", async () => {
    const store = newStore();
    await store.uploadPackage({ files, actorId: "actor" });
    const result = await store.runPackageChecks({ key: "release-flow", checkedAt: "2026-06-30T00:00:00Z" });
    expect(result.summary).toBeDefined();
    expect(store.getPackageDraft("release-flow")?.checks).not.toBeNull();
  });

  it("uploadPackage rejects zip-slip path (UT-006)", async () => {
    const store = newStore();
    const unsafe: SourceFile[] = [{ path: "../evil.md", content: "x" }, ...files];
    await expect(store.uploadPackage({ files: unsafe, actorId: "actor" }))
      .rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("uploadPackage rejects sensitive content (UT-007)", async () => {
    const store = newStore();
    const sensitive: SourceFile[] = [
      { path: "workflow.yaml", content: workflowYaml },
      { path: "agents/release.md", content: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }
    ];
    await expect(store.uploadPackage({ files: sensitive, actorId: "actor" }))
      .rejects.toMatchObject({ code: "SENSITIVE_CONTENT_BLOCKED" });
  });

  it("uploadPackage rejects missing workflow.yaml (UT-008)", async () => {
    const store = newStore();
    const noManifest: SourceFile[] = [{ path: "agents/release.md", content: "# x" }];
    await expect(store.uploadPackage({ files: noManifest, actorId: "actor" }))
      .rejects.toMatchObject({ code: "WORKFLOW_MANIFEST_MISSING" });
  });

  it("diffPackageDraft returns diff files (UT-014)", async () => {
    const store = newStore();
    await store.uploadPackage({ files, actorId: "actor" });
    const diff = store.diffPackageDraft("release-flow");
    expect(Array.isArray(diff)).toBe(true);
  });
});

describe("WorkflowPackageStore publish + list (UT-010~013)", () => {
  it("publishPackage produces artifact and advances version (UT-010)", async () => {
    const store = newStore();
    await store.uploadPackage({ files, actorId: "actor" });
    const version = await store.publishPackage("release-flow", { version: "1.0.0", releaseNote: "init", actorId: "actor" });
    expect(version.version).toBe("1.0.0");
    expect(version.artifacts).toHaveLength(1);
    const pkg = store.getPackage("release-flow");
    expect(pkg?.latestVersion).toBe("1.0.0");
  });

  it("publishPackage artifact contains workflow.yaml + shared resources + hunter-workflow.json (UT-011)", async () => {
    const storage = new MemoryArtifactStorage();
    const store = new WorkflowPackageStore({ storage, packages: new Map(), drafts: new Map(), persist: async () => {}, compilerVersion: () => "1.0.0" });
    await store.uploadPackage({ files, actorId: "actor" });
    const version = await store.publishPackage("release-flow", { version: "1.0.0", actorId: "actor" });
    const blob = await storage.getBlob(version.artifacts[0]?.content_sha256 ?? "");
    const zip = new AdmZip(blob);
    expect(zip.getEntry("workflow.yaml")).not.toBeNull();
    expect(zip.getEntry("agents/release.md")).not.toBeNull();
    expect(zip.getEntry("hunter-workflow.json")).not.toBeNull();
  });

  it("publishPackage rejects non-forward version (UT-012)", async () => {
    const store = newStore();
    await store.uploadPackage({ files, actorId: "actor" });
    await store.publishPackage("release-flow", { version: "1.0.0", actorId: "actor" });
    await store.uploadPackage({ files, actorId: "actor" });
    await expect(store.publishPackage("release-flow", { version: "1.0.0", actorId: "actor" }))
      .rejects.toMatchObject({ code: "SKILL_VERSION_NOT_FORWARD" });
  });

  it("listPackageVersions returns version sequence newest-first (UT-013)", async () => {
    const store = newStore();
    await store.uploadPackage({ files, actorId: "actor" });
    await store.publishPackage("release-flow", { version: "1.0.0", actorId: "actor" });
    await store.uploadPackage({ files, actorId: "actor" });
    await store.publishPackage("release-flow", { version: "1.0.1", actorId: "actor" });
    const versions = store.listPackageVersions("release-flow");
    expect(versions.map((v) => v.version)).toEqual(["1.0.1", "1.0.0"]);
  });
});
