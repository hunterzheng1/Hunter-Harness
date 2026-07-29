import { createConnection } from "node:net";
import {
  readFile,
  readdir,
  stat
} from "node:fs/promises";
import { join } from "node:path";

export type CodeGraphCoverage =
  | "CURRENT"
  | "PENDING"
  | "STALE"
  | "INDEX_PRESENT_UNVERIFIED"
  | "MISSING"
  | "UNKNOWN";

export interface CodeGraphStatus {
  status: "OK" | "WARN" | "UNKNOWN";
  reasonCode:
    | "OK"
    | "CODEGRAPH_INDEX_MISSING"
    | "CODEGRAPH_INDEX_PENDING"
    | "CODEGRAPH_SERVICE_UNREACHABLE"
    | "CODEGRAPH_WATCHER_UNVERIFIED"
    | "CODEGRAPH_STATUS_UNAVAILABLE";
  serviceReachable: boolean | null;
  indexedCommit: string | null;
  indexedCommitSource: "inferred-current-head" | "unavailable";
  pendingFileCount: number | null;
  watcherLagMs: number | null;
  coverage: CodeGraphCoverage;
  indexObservedAt: string | null;
  watcherActive: boolean | null;
  action: string;
}

export interface CodeGraphStatusOptions {
  now?: () => Date;
  headCommit?: string | null;
  socketProbe?: (socketPath: string, pid: number | null) => Promise<boolean>;
}

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".harness",
  ".codegraph",
  ".next",
  ".tmp",
  ".uv",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "tmp",
  "venv"
]);

interface DaemonReceipt {
  pid: number | null;
  socketPath: string | null;
}

async function pathMtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function readDaemonReceipt(path: string): Promise<DaemonReceipt> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      pid?: unknown;
      socketPath?: unknown;
    };
    return {
      pid: typeof value.pid === "number" && Number.isInteger(value.pid)
        ? value.pid
        : null,
      socketPath: typeof value.socketPath === "string" && value.socketPath.trim() !== ""
        ? value.socketPath
        : null
    };
  } catch {
    return { pid: null, socketPath: null };
  }
}

async function defaultSocketProbe(
  socketPath: string,
  pid: number | null
): Promise<boolean> {
  if (socketPath.trim() !== "") {
    return await new Promise<boolean>((resolveProbe) => {
      let settled = false;
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolveProbe(value);
      };
      const socket = createConnection(socketPath);
      const timer = setTimeout(() => settle(false), 750);
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
    });
  }
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function watcherState(log: string): boolean | null {
  const active = log.lastIndexOf("File watcher active");
  const disabled = Math.max(
    log.lastIndexOf("auto-sync is DISABLED"),
    log.lastIndexOf("File watcher stopped")
  );
  if (active < 0 && disabled < 0) return null;
  return active > disabled;
}

async function countFilesNewerThan(
  root: string,
  thresholdMs: number
): Promise<number> {
  let count = 0;
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          await visit(path);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const modifiedAt = await pathMtimeMs(path);
      if (modifiedAt !== null && modifiedAt > thresholdMs + 50) {
        count += 1;
      }
    }
  };
  await visit(root);
  return count;
}

export async function assessCodeGraphStatus(
  root: string,
  options: CodeGraphStatusOptions = {}
): Promise<CodeGraphStatus> {
  const graphRoot = join(root, ".codegraph");
  const databasePath = join(graphRoot, "codegraph.db");
  const databaseMtime = await pathMtimeMs(databasePath);
  if (databaseMtime === null) {
    return {
      status: "WARN",
      reasonCode: "CODEGRAPH_INDEX_MISSING",
      serviceReachable: false,
      indexedCommit: null,
      indexedCommitSource: "unavailable",
      pendingFileCount: null,
      watcherLagMs: null,
      coverage: "MISSING",
      indexObservedAt: null,
      watcherActive: null,
      action: "Run `codegraph init` explicitly if this project should be indexed."
    };
  }

  try {
    const now = (options.now ?? (() => new Date()))();
    const daemon = await readDaemonReceipt(join(graphRoot, "daemon.pid"));
    const probe = options.socketProbe ?? defaultSocketProbe;
    const serviceReachable = daemon.socketPath === null && daemon.pid === null
      ? null
      : await probe(daemon.socketPath ?? "", daemon.pid);
    let log = "";
    try {
      log = await readFile(join(graphRoot, "daemon.log"), "utf8");
    } catch {
      // A database can exist without the optional daemon log.
    }
    const watcherActive = watcherState(log);
    const observedCandidates = await Promise.all([
      Promise.resolve(databaseMtime),
      pathMtimeMs(join(graphRoot, "codegraph.db-wal")),
      pathMtimeMs(join(graphRoot, "daemon.log"))
    ]);
    const indexObservedMs = Math.max(
      ...observedCandidates.filter((value): value is number => value !== null)
    );
    const pendingFileCount = await countFilesNewerThan(root, indexObservedMs);
    const indexObservedAt = new Date(indexObservedMs).toISOString();
    const watcherLagMs = pendingFileCount > 0
      ? Math.max(0, now.getTime() - indexObservedMs)
      : 0;

    if (serviceReachable === false || watcherActive === false) {
      return {
        status: "WARN",
        reasonCode: "CODEGRAPH_SERVICE_UNREACHABLE",
        serviceReachable,
        indexedCommit: null,
        indexedCommitSource: "unavailable",
        pendingFileCount,
        watcherLagMs,
        coverage: "STALE",
        indexObservedAt,
        watcherActive,
        action: "Restart the CodeGraph integration; no automatic full reindex was triggered."
      };
    }
    if (serviceReachable === null || watcherActive === null) {
      return {
        status: "WARN",
        reasonCode: "CODEGRAPH_WATCHER_UNVERIFIED",
        serviceReachable,
        indexedCommit: null,
        indexedCommitSource: "unavailable",
        pendingFileCount,
        watcherLagMs,
        coverage: "INDEX_PRESENT_UNVERIFIED",
        indexObservedAt,
        watcherActive,
        action: "Verify the CodeGraph daemon and watcher; no automatic full reindex was triggered."
      };
    }
    if (pendingFileCount > 0) {
      return {
        status: "WARN",
        reasonCode: "CODEGRAPH_INDEX_PENDING",
        serviceReachable,
        indexedCommit: null,
        indexedCommitSource: "unavailable",
        pendingFileCount,
        watcherLagMs,
        coverage: "PENDING",
        indexObservedAt,
        watcherActive,
        action: "Wait for incremental synchronization; no automatic full reindex was triggered."
      };
    }
    const headCommit = options.headCommit !== undefined &&
      options.headCommit !== null &&
      /^[a-f0-9]{40}$/i.test(options.headCommit)
      ? options.headCommit
      : null;
    return {
      status: "OK",
      reasonCode: "OK",
      serviceReachable,
      indexedCommit: headCommit,
      indexedCommitSource: headCommit === null ? "unavailable" : "inferred-current-head",
      pendingFileCount,
      watcherLagMs,
      coverage: "CURRENT",
      indexObservedAt,
      watcherActive,
      action: "No reindex required."
    };
  } catch {
    return {
      status: "UNKNOWN",
      reasonCode: "CODEGRAPH_STATUS_UNAVAILABLE",
      serviceReachable: null,
      indexedCommit: null,
      indexedCommitSource: "unavailable",
      pendingFileCount: null,
      watcherLagMs: null,
      coverage: "UNKNOWN",
      indexObservedAt: null,
      watcherActive: null,
      action: "Inspect CodeGraph diagnostics; no automatic full reindex was triggered."
    };
  }
}
