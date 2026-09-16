import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AdapterBundleError,
  FIXED_PROFILE,
  loadBundle,
  PROJECTION_SURFACES
} from "../src/project/profile-bundle.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

function shaHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("loadBundle (v1.0 flattened single-bundle layout)", () => {
  it("loads every projection surface from harness/bundles/<surface> with manifest-valid hashes", async () => {
    for (const surface of PROJECTION_SURFACES) {
      const bundle = await loadBundle(resourcesRoot, surface);
      expect(bundle.manifest.adapter).toBe(surface);
      expect(bundle.manifest.profile).toBe(FIXED_PROFILE);
      expect(bundle.manifest.schema_version).toBe(2);
      expect(bundle.manifest.files.length).toBeGreaterThan(0);
      for (const entry of bundle.manifest.files) {
        const bytes = bundle.files.get(entry.path);
        expect(bytes, entry.path).toBeDefined();
        expect(shaHex(bytes as Uint8Array), entry.path).toBe(entry.sha256);
      }
    }
  });

  it("excludes the .harness-build.json marker from every manifest", async () => {
    for (const surface of PROJECTION_SURFACES) {
      const bundle = await loadBundle(resourcesRoot, surface);
      expect(bundle.manifest.files.some((f) => f.path === ".harness-build.json")).toBe(false);
      expect(bundle.files.has(".harness-build.json")).toBe(false);
    }
  });

  it("caches per resourcesRoot+surface and returns the same manifest object", async () => {
    const first = await loadBundle(resourcesRoot, "codex");
    const second = await loadBundle(resourcesRoot, "codex");
    expect(second.manifest).toBe(first.manifest);
  });

  it("raises ADAPTER_BUNDLE_MISSING (exit 7) when the bundle directory is absent", async () => {
    const missingRoot = fileURLToPath(new URL("../test/__no_such_resources__", import.meta.url));
    let caught: unknown;
    try {
      await loadBundle(missingRoot, "codex");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdapterBundleError);
    expect((caught as AdapterBundleError).code).toBe("ADAPTER_BUNDLE_MISSING");
    expect((caught as AdapterBundleError).exitCode).toBe(7);
  });

  it("rejects unknown surfaces before hitting the filesystem", async () => {
    await expect(loadBundle(resourcesRoot, "pi" as never)).rejects.toMatchObject({
      name: "AdapterBundleError",
      code: "ADAPTER_BUNDLE_INVALID"
    });
  });
});
