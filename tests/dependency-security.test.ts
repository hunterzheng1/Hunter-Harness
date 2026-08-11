import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageLockEntry {
  version?: string;
}

interface PackageLock {
  packages: Record<string, PackageLockEntry>;
}

function numericVersion(version: string): readonly number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function expectAtLeast(actual: string | undefined, minimum: string): void {
  expect(actual, `expected a locked version at or above ${minimum}`).toBeDefined();
  const left = numericVersion(actual ?? "0.0.0");
  const right = numericVersion(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference === 0) continue;
    expect(difference, `${actual} must be at or above ${minimum}`).toBeGreaterThan(0);
    return;
  }
}

function lockedVersions(lock: PackageLock, packageName: string): string[] {
  const suffix = `/node_modules/${packageName}`;
  return Object.entries(lock.packages)
    .filter(([path]) => path === `node_modules/${packageName}` || path.endsWith(suffix))
    .flatMap(([, entry]) => entry.version === undefined ? [] : [entry.version]);
}

describe("production dependency security floor", () => {
  it("locks every audited runtime dependency to a patched release", async () => {
    const lock = JSON.parse(
      await readFile(new URL("../package-lock.json", import.meta.url), "utf8")
    ) as PackageLock;
    const minimums: Record<string, string> = {
      "adm-zip": "0.6.0",
      "brace-expansion": "5.0.9",
      "ip-address": "10.3.1",
      "tar": "7.5.21",
      "undici": "6.28.0"
    };

    for (const [packageName, minimum] of Object.entries(minimums)) {
      const versions = lockedVersions(lock, packageName);
      expect(versions, `${packageName} must be present in the production lock`).not.toHaveLength(0);
      for (const version of versions) expectAtLeast(version, minimum);
    }
  });
});
