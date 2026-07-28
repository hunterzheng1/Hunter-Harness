import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("config origin discovery", () => {
  it("SYNC-CONFIG-001 reports canonical/projection origins and drift without overwriting", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-config-origins-"));
    const canonical = join(root, "docs", "ai", "harness", "harness.json");
    const projection = join(root, ".harness", "config", "harness.json");
    await mkdir(join(root, "docs", "ai", "harness"), { recursive: true });
    await mkdir(join(root, ".harness", "config"), { recursive: true });
    await writeFile(canonical, "{\"mode\":\"canonical\"}\n");
    await writeFile(projection, "{\"mode\":\"drifted\"}\n");
    const stdout: string[] = [];
    try {
      const code = await runCli(["config", "show", "--origins", "--json"], {
        cwd: root,
        resourcesRoot,
        stdout: (value) => stdout.push(value),
        stderr: () => undefined
      });
      expect(code).toBe(0);
      const result = JSON.parse(stdout.join("")) as {
        status: string;
        origins: Array<{
          name: string;
          canonicalPath: string;
          projectionPath: string;
          drift: boolean;
        }>;
      };
      expect(result.status).toBe("WARN");
      expect(result.origins).toContainEqual(expect.objectContaining({
        name: "harness.json",
        canonicalPath: "docs/ai/harness/harness.json",
        projectionPath: ".harness/config/harness.json",
        drift: true
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
