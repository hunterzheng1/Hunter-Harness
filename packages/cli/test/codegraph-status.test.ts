import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assessCodeGraphStatus } from "../src/sync/codegraph-status.js";

const NOW = new Date("2026-07-29T12:00:00.000Z");

describe("CodeGraph status assessment", () => {
  it("S2: an unreachable daemon is advisory — the index remains queryable", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-codegraph-daemon-down-"));
    const graph = join(root, ".codegraph");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(graph, { recursive: true });
    try {
      const indexed = new Date(NOW.getTime() - 1_000);
      await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
      await writeFile(join(graph, "codegraph.db"), "index");
      await writeFile(
        join(graph, "daemon.pid"),
        JSON.stringify({ pid: 42, socketPath: "\\\\.\\pipe\\codegraph-test" })
      );
      await utimes(join(root, "src", "app.ts"), indexed, indexed);
      await utimes(join(graph, "codegraph.db"), indexed, indexed);

      const result = await assessCodeGraphStatus(root, {
        now: () => NOW,
        headCommit: "a".repeat(40),
        socketProbe: async () => false,
        statusProbe: async () => null
      });

      // daemon 未运行 ≠ 索引不可用：ADVISORY 而非 WARN
      expect(result.status).toBe("ADVISORY");
      expect(result.reasonCode).toBe("CODEGRAPH_SERVICE_UNREACHABLE");
      expect(result.action).toContain("仍可正常查询");
      expect(result.action).toContain("增量");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats an unchanged local index with an unverified watcher as advisory", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-codegraph-unverified-watcher-"));
    const graph = join(root, ".codegraph");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(graph, { recursive: true });
    try {
      const indexed = new Date(NOW.getTime() - 1_000);
      await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
      await writeFile(join(graph, "codegraph.db"), "index");
      await utimes(join(root, "src", "app.ts"), indexed, indexed);
      await utimes(join(graph, "codegraph.db"), indexed, indexed);

      const result = await assessCodeGraphStatus(root, {
        now: () => NOW,
        headCommit: "a".repeat(40),
        statusProbe: async () => null
      });

      expect(result.status).toBe("ADVISORY");
      expect(result.reasonCode).toBe("CODEGRAPH_WATCHER_UNVERIFIED");
      expect(result.coverage).toBe("INDEX_PRESENT_UNVERIFIED");
      expect(result.pendingFileCount).toBe(0);
      expect(result.action).toContain("索引可用");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing index without triggering a reindex", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-codegraph-missing-"));
    try {
      const result = await assessCodeGraphStatus(root, {
        now: () => NOW,
        socketProbe: async () => false
      });

      expect(result.coverage).toBe("MISSING");
      expect(result.status).toBe("WARN");
      expect(result.reasonCode).toBe("CODEGRAPH_INDEX_MISSING");
      expect(result.action).toContain("codegraph init");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports current coverage when the daemon watcher has caught up", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-codegraph-current-"));
    const graph = join(root, ".codegraph");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(graph, { recursive: true });
    try {
      const old = new Date(NOW.getTime() - 60_000);
      const recent = new Date(NOW.getTime() - 1_000);
      const source = join(root, "src", "app.ts");
      const database = join(graph, "codegraph.db");
      const log = join(graph, "daemon.log");
      await writeFile(source, "export const value = 1;\n");
      await writeFile(database, "index");
      await writeFile(
        join(graph, "daemon.pid"),
        JSON.stringify({ pid: 42, socketPath: "\\\\.\\pipe\\codegraph-test" })
      );
      await writeFile(
        log,
        "[CodeGraph MCP] File watcher active — graph will auto-sync on changes\n" +
          "[CodeGraph MCP] Auto-synced 1 file(s) in 20ms\n"
      );
      await utimes(source, old, old);
      await utimes(database, recent, recent);
      await utimes(log, recent, recent);

      const result = await assessCodeGraphStatus(root, {
        now: () => NOW,
        headCommit: "a".repeat(40),
        socketProbe: async () => true
      });

      expect(result.status).toBe("OK");
      expect(result.reasonCode).toBe("OK");
      expect(result.serviceReachable).toBe(true);
      expect(result.pendingFileCount).toBe(0);
      expect(result.watcherLagMs).toBe(0);
      expect(result.coverage).toBe("CURRENT");
      expect(result.indexedCommit).toBe("a".repeat(40));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when project files are newer than the observed index", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-codegraph-pending-"));
    const graph = join(root, ".codegraph");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(graph, { recursive: true });
    try {
      const stale = new Date(NOW.getTime() - 60_000);
      const changed = new Date(NOW.getTime() - 1_000);
      const source = join(root, "src", "app.ts");
      const database = join(graph, "codegraph.db");
      const log = join(graph, "daemon.log");
      await writeFile(source, "export const value = 2;\n");
      await writeFile(database, "index");
      await writeFile(
        join(graph, "daemon.pid"),
        JSON.stringify({ pid: 42, socketPath: "\\\\.\\pipe\\codegraph-test" })
      );
      await writeFile(
        log,
        "[CodeGraph MCP] File watcher active — graph will auto-sync on changes\n"
      );
      await utimes(database, stale, stale);
      await utimes(log, stale, stale);
      await utimes(source, changed, changed);

      const result = await assessCodeGraphStatus(root, {
        now: () => NOW,
        headCommit: "b".repeat(40),
        socketProbe: async () => true
      });

      expect(result.status).toBe("WARN");
      expect(result.reasonCode).toBe("CODEGRAPH_INDEX_PENDING");
      expect(result.coverage).toBe("PENDING");
      expect(result.pendingFileCount).toBe(1);
      expect(result.watcherLagMs).toBeGreaterThan(0);
      expect(result.indexedCommit).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses CodeGraph status as the authoritative pending source", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-codegraph-api-"));
    const graph = join(root, ".codegraph");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(graph, { recursive: true });
    try {
      const indexed = new Date(NOW.getTime() - 1_000);
      await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
      await writeFile(join(graph, "codegraph.db"), "index");
      await writeFile(
        join(graph, "daemon.pid"),
        JSON.stringify({ pid: 42, socketPath: "\\\\.\\pipe\\codegraph-test" })
      );
      await writeFile(
        join(graph, "daemon.log"),
        "[CodeGraph MCP] File watcher active — graph will auto-sync on changes\n"
      );
      await utimes(join(root, "src", "app.ts"), indexed, indexed);
      await utimes(join(graph, "codegraph.db"), indexed, indexed);

      const result = await assessCodeGraphStatus(root, {
        now: () => NOW,
        socketProbe: async () => true,
        statusProbe: async () => ({
          initialized: true,
          lastIndexed: indexed.toISOString(),
          pendingChanges: { added: 1, modified: 2, removed: 1 },
          index: { state: "complete" }
        })
      });

      expect(result.pendingSource).toBe("codegraph-api");
      expect(result.pendingFileCount).toBe(4);
      expect(result.coverage).toBe("PENDING");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not use daemon log mtime as index observation time", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-codegraph-log-"));
    const graph = join(root, ".codegraph");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(graph, { recursive: true });
    try {
      const databaseTime = new Date(NOW.getTime() - 60_000);
      const sourceTime = new Date(NOW.getTime() - 30_000);
      const logTime = new Date(NOW.getTime() - 1_000);
      await writeFile(join(root, "src", "app.ts"), "export const value = 2;\n");
      await writeFile(join(graph, "codegraph.db"), "index");
      await writeFile(
        join(graph, "daemon.pid"),
        JSON.stringify({ pid: 42, socketPath: "\\\\.\\pipe\\codegraph-test" })
      );
      await writeFile(
        join(graph, "daemon.log"),
        "[CodeGraph MCP] File watcher active — graph will auto-sync on changes\n"
      );
      await utimes(join(graph, "codegraph.db"), databaseTime, databaseTime);
      await utimes(join(root, "src", "app.ts"), sourceTime, sourceTime);
      await utimes(join(graph, "daemon.log"), logTime, logTime);

      const result = await assessCodeGraphStatus(root, {
        now: () => NOW,
        socketProbe: async () => true,
        statusProbe: async () => null
      });

      expect(result.pendingSource).toBe("database-scan");
      expect(result.indexObservedAt).toBe(databaseTime.toISOString());
      expect(result.pendingFileCount).toBe(1);
      expect(result.coverage).toBe("PENDING");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores adapter and non-indexable files in the database fallback scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-codegraph-ignore-"));
    const graph = join(root, ".codegraph");
    await mkdir(join(root, ".agents", "skills", "example"), { recursive: true });
    await mkdir(graph, { recursive: true });
    try {
      const databaseTime = new Date(NOW.getTime() - 60_000);
      const changed = new Date(NOW.getTime() - 1_000);
      await writeFile(join(graph, "codegraph.db"), "index");
      await writeFile(
        join(graph, "daemon.pid"),
        JSON.stringify({ pid: 42, socketPath: "\\\\.\\pipe\\codegraph-test" })
      );
      await writeFile(
        join(graph, "daemon.log"),
        "[CodeGraph MCP] File watcher active — graph will auto-sync on changes\n"
      );
      const adapter = join(root, ".agents", "skills", "example", "SKILL.md");
      await writeFile(adapter, "# refreshed adapter\n");
      await writeFile(join(root, "README.md"), "# changed docs\n");
      await utimes(join(graph, "codegraph.db"), databaseTime, databaseTime);
      await utimes(adapter, changed, changed);
      await utimes(join(root, "README.md"), changed, changed);

      const result = await assessCodeGraphStatus(root, {
        now: () => NOW,
        socketProbe: async () => true,
        statusProbe: async () => null
      });

      expect(result.pendingSource).toBe("database-scan");
      expect(result.pendingFileCount).toBe(0);
      expect(result.coverage).toBe("CURRENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
