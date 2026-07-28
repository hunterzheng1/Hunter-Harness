import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("hunter-harness doctor", () => {
  it("reports duplicate and nested managed blocks without mutating the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-doctor-blocks-"));
    const path = join(root, "AGENTS.md");
    const malformed =
      "<!-- hunter-harness:start id=core -->\n" +
      "<!-- hunter-harness:start id=nested -->\nbody\n" +
      "<!-- hunter-harness:end id=nested -->\n" +
      "<!-- hunter-harness:end id=core -->\n";
    await writeFile(path, malformed);
    const stdout: string[] = [];
    try {
      const code = await runCli(["doctor", "--managed-blocks", "--json"], {
        cwd: root,
        resourcesRoot,
        stdout: (value) => stdout.push(value),
        stderr: () => undefined
      });

      expect(code).toBe(5);
      const payload = JSON.parse(stdout.join("")) as {
        status: string;
        managedBlocks: { findings: Array<{ code: string; path: string }> };
      };
      expect(payload.status).toBe("WARN");
      expect(payload.managedBlocks.findings).toContainEqual(expect.objectContaining({
        code: "NESTED_MANAGED_BLOCK",
        path: "AGENTS.md"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
