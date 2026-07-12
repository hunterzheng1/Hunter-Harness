import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { refreshManagedBlock } from "../src/managed/managed-block.js";
import { AGENTS_MANAGED_BLOCK_CONTENT } from "../src/project/managed-content.js";
import { initializeProject } from "../src/project/initialize.js";
import { refreshProject } from "../src/project/refresh.js";

const resourcesRoot = fileURLToPath(new URL("../../../resources", import.meta.url));

const START = "<!-- hunter-harness:start -->";
const END = "<!-- hunter-harness:end -->";

describe("managed markdown block refresh", () => {
  it("appends a block when markers are absent", () => {
    const original = "# User Doc\n\nkeep this.\n";
    const result = refreshManagedBlock(original, AGENTS_MANAGED_BLOCK_CONTENT);
    expect(result.conflict).toBe(false);
    expect(result.action).toBe("appended");
    expect(result.content).toContain("# User Doc");
    expect(result.content).toContain(AGENTS_MANAGED_BLOCK_CONTENT);
    expect(result.content.indexOf(START)).toBeLessThan(result.content.indexOf(END));
  });

  it("refreshes an existing valid block and leaves outside bytes byte-identical", () => {
    const before = "# Top user\n\n";
    const after = "\n## Bottom user\nmore\n";
    const original = before + START + "\nold block\n" + END + after;
    const result = refreshManagedBlock(original, AGENTS_MANAGED_BLOCK_CONTENT);
    expect(result.conflict).toBe(false);
    expect(result.action).toBe("refreshed");
    expect(result.content.startsWith(before)).toBe(true);
    expect(result.content.endsWith(after)).toBe(true);
    expect(result.content).toContain(AGENTS_MANAGED_BLOCK_CONTENT);
    expect(result.content).not.toContain("old block");
  });

  it("preserves the whole file and reports a conflict on duplicated start markers", () => {
    const original = "# Doc\n" + START + START + "\nblock\n" + END + "\n";
    const result = refreshManagedBlock(original, AGENTS_MANAGED_BLOCK_CONTENT);
    expect(result.conflict).toBe(true);
    expect(result.action).toBe("preserved_conflict");
    expect(result.content).toBe(original);
  });

  it("preserves the whole file and reports a conflict on reversed markers", () => {
    const original = "# Doc\n" + END + "\nblock\n" + START + "\n";
    const result = refreshManagedBlock(original, AGENTS_MANAGED_BLOCK_CONTENT);
    expect(result.conflict).toBe(true);
    expect(result.content).toBe(original);
  });

  it("preserves user text before and after the block byte-for-byte (CRLF aware)", () => {
    const before = "header line\r\n\r\n";
    const after = "\r\nfooter line\r\n";
    const original = before + START + "\r\nold\r\n" + END + after;
    const result = refreshManagedBlock(original, AGENTS_MANAGED_BLOCK_CONTENT);
    expect(result.content.startsWith(before)).toBe(true);
    expect(result.content.endsWith(after)).toBe(true);
  });
});

describe("managed block conflicts during refresh", () => {
  it("preserves a malformed AGENTS.md as conflict while other targets still update", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-block-conflict-"));
    await initializeProject({
      projectRoot: root, resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" }, dryRun: false
    });
    // 破坏 AGENTS.md 标记（重复 start）。
    await writeFile(
      join(root, "AGENTS.md"),
      "# Doc\n" + START + START + "\nblock\n" + END + "\n"
    );
    // 删掉一个 Bundle 目标，refresh 应补回（即使 AGENTS 冲突）。
    await rm(join(root, ".claude", "agents", "harness-reviewer.md"), { force: true });

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", agents: ["claude-code"], dryRun: false, forceManaged: false
    });

    expect(result.conflicts.some((c) => c.target_path === "AGENTS.md")).toBe(true);
    expect(result.conflicts.some((c) => c.reason === "MALFORMED_MANAGED_BLOCK")).toBe(true);
    // AGENTS.md 原样保留。
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
      "# Doc\n" + START + START + "\nblock\n" + END + "\n"
    );
    // 另一个安全目标仍被补回。
    expect(result.applied.some((i) => i.target_path === ".claude/agents/harness-reviewer.md")).toBe(true);
  });

  it("--force-managed never overwrites bytes outside the managed block", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-block-force-"));
    await initializeProject({
      projectRoot: root, resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" }, dryRun: false
    });
    const before = "# Top user\n\n";
    const after = "\n## Bottom user\n";
    const validWithUser = before + START + "\nold\n" + END + after;
    await writeFile(join(root, "AGENTS.md"), validWithUser);

    const result = await refreshProject({
      projectRoot: root, resourcesRoot, profile: "general", agents: ["claude-code"], dryRun: false, forceManaged: true
    });
    const refreshed = await readFile(join(root, "AGENTS.md"), "utf8");
    // force-managed 只替换块内，块外用户字节逐字保留。
    expect(refreshed.startsWith(before)).toBe(true);
    expect(refreshed.endsWith(after)).toBe(true);
    expect(refreshed).toContain(AGENTS_MANAGED_BLOCK_CONTENT);
    // 畸形标记才会冲突；合法块即便 force 也不报冲突。
    expect(result.conflicts.some((c) => c.target_path === "AGENTS.md")).toBe(false);
  });
});
