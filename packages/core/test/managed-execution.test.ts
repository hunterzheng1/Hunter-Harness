import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolvePythonRuntime,
  runManagedProcess,
  runPythonJson
} from "@hunter-harness/core";

describe("core managed execution transport", () => {
  it("owns runtime resolution without importing the CLI package", async () => {
    const runtime = await resolvePythonRuntime({
      projectRoot: "C:\\project",
      env: { HUNTER_HARNESS_PYTHON: "configured-python" },
      probe: async (argv) => argv[0] === "configured-python"
        ? { ok: true, version: "Python 3.13.5", executable: argv[0] ?? null }
        : { ok: false, version: "", executable: null }
    });
    expect(runtime.source).toBe("environment");
    expect(runtime.argvPrefix).toEqual(["configured-python"]);

    const source = await readFile(
      join(process.cwd(), "packages", "core", "src", "runtime", "managed-execution.ts"),
      "utf8"
    );
    expect(source).not.toContain("packages/cli");
  });

  it("preserves argv elements and parses typed JSON output", async () => {
    const result = await runPythonJson({
      projectRoot: process.cwd(),
      env: {},
      runtime: {
        available: true,
        source: "python",
        executable: process.execPath,
        argvPrefix: [process.execPath],
        version: "node-test",
        attempts: []
      },
      script: "-e",
      args: [
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        "a b",
        "中文"
      ],
      parse: (value) => value as string[]
    });
    expect(result.reasonCode).toBe("OK");
    expect(result.value).toContain("a b");
    expect(result.value).toContain("中文");
  });

  it("keeps stable nonzero and timeout classifications", async () => {
    const nonzero = await runManagedProcess(
      [process.execPath, "-e", "process.exit(7)"],
      process.cwd(),
      {},
      () => undefined,
      { wallTimeoutMs: 2_000 }
    );
    expect(nonzero.exitCode).toBe(7);
    expect(nonzero.termination).toBe("exited");

    const timeout = await runManagedProcess(
      [process.execPath, "-e", "setInterval(() => undefined, 1000)"],
      process.cwd(),
      {},
      () => undefined,
      { wallTimeoutMs: 80, terminateGraceMs: 20, heartbeatMs: 10 }
    );
    expect(timeout.timedOut).toBe(true);
    expect(timeout.timeoutKind).toBe("wall");
    expect(timeout.termination).toMatch(/terminated|killed/);
  });
});
