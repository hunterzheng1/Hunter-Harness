import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as Core from "@hunter-harness/core";

/**
 * O6 工作包 F5b 决策点 8：republish 载荷治理。
 * Python `harness_archive.py republish --json` 是唯一权威投递链；CLI 只允许
 * fail-closed 校验 + 透传，不得再改写业务判定（不伪造 buildCount、不把
 * selectedChange 回退到 CLI 参数、不静默吞掉畸形载荷）。
 */

vi.mock("@hunter-harness/core", async (importOriginal) => {
  const actual = await importOriginal<typeof Core>();
  return { ...actual, runPythonJson: vi.fn() };
});

const { runPythonJson } = await import("@hunter-harness/core");
const { runRepublishArchive } = await import("../src/commands/push-pull.js");
const mockedRunPythonJson = vi.mocked(runPythonJson);

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hh-republish-"));
  await mkdir(join(root, "harness", "scripts"), { recursive: true });
  await writeFile(join(root, "harness", "scripts", "harness_archive.py"), "# stub\n", "utf8");
  return root;
}

function mockPython(exitCode: number, payload: unknown): void {
  mockedRunPythonJson.mockImplementation(async (options) => {
    const process = {
      exitCode, stdout: JSON.stringify(payload), stderr: "",
      startedAt: "2026-09-15T00:00:00.000Z", completedAt: "2026-09-15T00:00:00.001Z",
      durationMs: 1, timedOut: false, stdoutTruncated: false, stderrTruncated: false
    };
    if (exitCode !== 0) {
      return { process, value: null, reasonCode: "CHILD_EXIT_NONZERO" as const };
    }
    try {
      return { process, value: options.parse(payload), reasonCode: "OK" as const };
    } catch {
      return { process, value: null, reasonCode: "TYPED_OUTPUT_INVALID" as const };
    }
  });
}

afterEach(() => {
  mockedRunPythonJson.mockReset();
});

describe("runRepublishArchive 载荷治理（O6 F5b 决策点 8）", () => {
  it("透传 Python 权威判定，CLI 不伪造业务字段", async () => {
    const root = await workspace();
    mockPython(0, {
      ok: true, action: "republish", changeKey: "change-7", selectedChange: "change-7",
      reasonCode: "ARCHIVE_REPUBLISH_COMPLETE"
    });

    const result = await runRepublishArchive("change-7", false, {
      cwd: root, resourcesRoot: root, stderr: () => {}
    } as never);

    expect(result).toMatchObject({
      ok: true,
      reasonCode: "ARCHIVE_REPUBLISH_COMPLETE",
      archiveSource: "sealed",
      selectedChange: "change-7"
    });
    expect(result).not.toHaveProperty("buildCount");
  });

  it("selectedChange 以 Python payload 为准，不回退到 CLI 参数", async () => {
    const root = await workspace();
    mockPython(0, { ok: true, changeKey: "change-2" });

    const result = await runRepublishArchive("change-1", false, {
      cwd: root, resourcesRoot: root, stderr: () => {}
    } as never);

    expect(result.selectedChange).toBe("change-2");
  });

  it("payload 无 selectedChange/changeKey 时 selectedChange 为 undefined", async () => {
    const root = await workspace();
    mockPython(0, { ok: true, noChanges: true, reasonCode: "ARCHIVE_REPUBLISH_NO_CHANGES" });

    const result = await runRepublishArchive("change-1", false, {
      cwd: root, resourcesRoot: root, stderr: () => {}
    } as never);

    expect(result.selectedChange).toBeUndefined();
    expect(result.noChanges).toBe(true);
  });

  it("载荷缺 ok 布尔时 fail-closed：TYPED_OUTPUT_INVALID，不静默改写", async () => {
    const root = await workspace();
    mockPython(0, { changeKey: "change-1" });

    const result = await runRepublishArchive("change-1", false, {
      cwd: root, resourcesRoot: root, stderr: () => {}
    } as never);

    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("TYPED_OUTPUT_INVALID");
  });

  it("子进程非零退出：传输层失败优先于载荷内容", async () => {
    const root = await workspace();
    mockPython(1, { ok: true, changeKey: "change-1" });

    const result = await runRepublishArchive("change-1", false, {
      cwd: root, resourcesRoot: root, stderr: () => {}
    } as never);

    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("CHILD_EXIT_NONZERO");
  });
});
