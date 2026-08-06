import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runEventsSync } from "../src/commands/events-sync.js";
import type { CommandDependencies } from "../src/commands/configure.js";

describe("hunter-harness events-sync", () => {
  it("returns JSON envelope when remote credentials are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "hh-events-sync-"));
    await mkdir(join(root, ".harness", "changes", "demo"), { recursive: true });
    await writeFile(
      join(root, ".harness", "changes", "demo", "events.ndjson"),
      "{\"id\":\"e1\",\"type\":\"phase.start\",\"phase\":\"plan\",\"ts\":\"2026-08-06T00:00:00Z\"}\n",
      "utf8"
    );

    const stdout: string[] = [];
    const stderr: string[] = [];
    const dependencies = {
      cwd: root,
      resourcesRoot: join(root, "missing-resources"),
      stdout: (chunk: string) => {
        stdout.push(chunk);
      },
      stderr: (chunk: string) => {
        stderr.push(chunk);
      },
      prompt: async () => "",
      fetch: globalThis.fetch,
      env: process.env
    } as CommandDependencies;

    // Script resolution falls back to the monorepo harness/scripts path.
    const code = await runEventsSync({ json: true }, dependencies);
    expect(typeof code).toBe("number");
    const payload = JSON.parse(stdout.join("") || "{}") as {
      command?: string;
      schema_version?: number;
      ok?: boolean;
    };
    expect(payload.command).toBe("events-sync");
    expect(payload.schema_version).toBe(1);
    // Without credentials the python helper reports skipped/ok or failure — either way envelope exists.
    expect(typeof payload.ok).toBe("boolean");
  });
});
