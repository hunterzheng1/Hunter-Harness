import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assessCodeGraphStatus } from "../src/sync/codegraph-status.js";

const NOW = new Date("2026-07-29T12:00:00.000Z");

describe("CodeGraph status assessment", () => {
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
});
