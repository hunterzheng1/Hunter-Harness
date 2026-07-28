import { describe, expect, it } from "vitest";

import { resolvePythonRuntime } from "../src/runtime/python.js";

describe("Python runtime resolver", () => {
  it("SYNC-RUNTIME-001 selects uv when only uv can launch Python", async () => {
    const calls: string[][] = [];
    const runtime = await resolvePythonRuntime({
      projectRoot: "C:\\project",
      env: {},
      probe: async (argv) => {
        calls.push([...argv]);
        return argv[0] === "uv" && argv[1] === "run" && argv[2] === "python"
          ? { ok: true, version: "Python 3.13.5", executable: "C:\\tools\\uv.exe" }
          : { ok: false, version: "", executable: null };
      }
    });

    expect(runtime.available).toBe(true);
    expect(runtime.source).toBe("uv");
    expect(runtime.argvPrefix).toEqual(["uv", "run", "python"]);
    expect(calls.some((call) => call[0] === "uv")).toBe(true);
  });

  it("prefers HUNTER_HARNESS_PYTHON over every fallback", async () => {
    const runtime = await resolvePythonRuntime({
      projectRoot: "/project",
      env: { HUNTER_HARNESS_PYTHON: "/opt/hunter/python" },
      probe: async (argv) => ({
        ok: argv[0] === "/opt/hunter/python",
        version: "Python 3.12.9",
        executable: argv[0] ?? null
      })
    });

    expect(runtime.source).toBe("environment");
    expect(runtime.argvPrefix).toEqual(["/opt/hunter/python"]);
  });
});
