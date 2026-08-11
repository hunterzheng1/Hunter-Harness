import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import {
  readFile,
  readdir,
  stat
} from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CodeGraphCoverage =
  | "CURRENT"
  | "PENDING"
  | "STALE"
  | "INDEX_PRESENT_UNVERIFIED"
  | "MISSING"
  | "UNKNOWN";

export interface CodeGraphStatus {
  status: "OK" | "ADVISORY" | "WARN" | "UNKNOWN";
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
  pendingSource: "codegraph-api" | "database-scan" | "unverified";
  watcherLagMs: number | null;
  coverage: CodeGraphCoverage;
  indexObservedAt: string | null;
  watcherObservedAt: string | null;
  watcherActive: boolean | null;
  action: string;
}

export interface CodeGraphStatusOptions {
  now?: () => Date;
  headCommit?: string | null;
  socketProbe?: (socketPath: string, pid: number | null) => Promise<boolean>;
  statusProbe?: (root: string) => Promise<unknown | null>;
}

const EXCLUDED_DIRECTORIES = new Set([
  ".agents",
  ".claude",
  ".codebuddy",
  ".cursor",
  ".git",
  ".github",
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

const INDEXABLE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".cts",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".liquid",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);

interface DaemonReceipt {
  pid: number | null;
  socketPath: string | null;
}

interface CodeGraphCliStatus {
  initialized?: unknown;
  lastIndexed?: unknown;
  pendingChanges?: {
    added?: unknown;
    modified?: unknown;
    removed?: unknown;
  };
  index?: {
    state?: unknown;
  };
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

async function defaultStatusProbe(root: string): Promise<unknown | null> {
  try {
    const result = await execFileAsync(
      "codegraph",
      ["status", "--json", root],
      {
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: "utf8"
      }
    );
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function parseCliStatus(value: unknown): {
  pendingFileCount: number;
  indexObservedMs: number | null;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value as CodeGraphCliStatus;
  if (status.initialized !== true || status.index?.state !== "complete") return null;
  const pending = status.pendingChanges;
  if (pending === null || typeof pending !== "object") return null;
  const observed = typeof status.lastIndexed === "string"
    ? Date.parse(status.lastIndexed)
    : Number.NaN;
  return {
    pendingFileCount:
      nonNegativeInteger(pending.added) +
      nonNegativeInteger(pending.modified) +
      nonNegativeInteger(pending.removed),
    indexObservedMs: Number.isFinite(observed) ? observed : null
  };
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
      if (!INDEXABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
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
      pendingSource: "unverified",
      watcherLagMs: null,
      coverage: "MISSING",
      indexObservedAt: null,
      watcherObservedAt: null,
      watcherActive: null,
      action: "如果希望为该项目建立代码图谱，请显式运行 `codegraph init`。"
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
      pathMtimeMs(join(graphRoot, "codegraph.db-wal"))
    ]);
    const databaseObservedMs = Math.max(
      ...observedCandidates.filter((value): value is number => value !== null)
    );
    const watcherObservedMs = await pathMtimeMs(join(graphRoot, "daemon.log"));
    const probedStatus = parseCliStatus(
      await (options.statusProbe ?? defaultStatusProbe)(root)
    );
    const pendingSource = probedStatus === null ? "database-scan" : "codegraph-api";
    const indexObservedMs = probedStatus?.indexObservedMs ?? databaseObservedMs;
    const pendingFileCount = probedStatus?.pendingFileCount ??
      await countFilesNewerThan(root, indexObservedMs);
    const indexObservedAt = new Date(indexObservedMs).toISOString();
    const watcherObservedAt = watcherObservedMs === null
      ? null
      : new Date(watcherObservedMs).toISOString();
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
        pendingSource,
        watcherLagMs,
        coverage: "STALE",
        indexObservedAt,
        watcherObservedAt,
        watcherActive,
        action: "CodeGraph 服务或 watcher 已不可用；请检查并重启集成。本次同步不会自动执行全量重建。"
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
        pendingSource,
        watcherLagMs,
        coverage: "PENDING",
        indexObservedAt,
        watcherObservedAt,
        watcherActive,
        action: "仍有源码等待进入 CodeGraph 索引；请等待增量同步完成。本次同步不会自动执行全量重建。"
      };
    }
    if (serviceReachable === null || watcherActive === null) {
      return {
        status: "ADVISORY",
        reasonCode: "CODEGRAPH_WATCHER_UNVERIFIED",
        serviceReachable,
        indexedCommit: null,
        indexedCommitSource: "unavailable",
        pendingFileCount,
        pendingSource,
        watcherLagMs,
        coverage: "INDEX_PRESENT_UNVERIFIED",
        indexObservedAt,
        watcherObservedAt,
        watcherActive,
        action: "CodeGraph 索引可用且未发现待同步源码；后台 watcher 尚未验证，可按需检查 daemon 状态。"
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
      pendingSource,
      watcherLagMs,
      coverage: "CURRENT",
      indexObservedAt,
      watcherObservedAt,
      watcherActive,
      action: "索引已是最新状态，无需重建。"
    };
  } catch {
    return {
      status: "UNKNOWN",
      reasonCode: "CODEGRAPH_STATUS_UNAVAILABLE",
      serviceReachable: null,
      indexedCommit: null,
      indexedCommitSource: "unavailable",
      pendingFileCount: null,
      pendingSource: "unverified",
      watcherLagMs: null,
      coverage: "UNKNOWN",
      indexObservedAt: null,
      watcherObservedAt: null,
      watcherActive: null,
      action: "暂时无法判断 CodeGraph 状态；请查看诊断信息。本次同步不会自动执行全量重建。"
    };
  }
}
