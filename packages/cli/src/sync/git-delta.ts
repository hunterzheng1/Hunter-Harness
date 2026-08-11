import { spawn } from "node:child_process";

export interface ChangedPathSummary {
  changedFileCount: number;
  excludedFileCount: number;
  categories: {
    source: number;
    test: number;
    docs: number;
    config: number;
    other: number;
  };
  topDirectories: Array<{ path: string; files: number }>;
}

export interface GitDeltaObservation extends ChangedPathSummary {
  headCommit: string | null;
  baselineCommit: string | null;
  baselineSource: "upstream-merge-base" | "none";
  shortstat: string | null;
  truncated: boolean;
}

interface GitResult {
  code: number;
  stdout: string;
  truncated: boolean;
}

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|java|kt|go|rs|cs|cpp|cc|c|h)$/i;
const CONFIG_EXTENSION = /\.(?:json|ya?ml|toml|ini|properties|config)$/i;

function categoryOf(path: string): keyof ChangedPathSummary["categories"] {
  const normalized = path.toLowerCase();
  if (
    /(^|\/)(?:test|tests|__tests__)(\/|$)/.test(normalized) ||
    /\.(?:test|spec)\.[^.]+$/.test(normalized)
  ) {
    return "test";
  }
  if (normalized.startsWith("docs/") || /\.(?:md|mdx|rst)$/.test(normalized)) {
    return "docs";
  }
  if (
    normalized.startsWith("config/") ||
    normalized.includes("/config/") ||
    CONFIG_EXTENSION.test(normalized)
  ) {
    return "config";
  }
  return SOURCE_EXTENSION.test(normalized) ? "source" : "other";
}

export function summarizeChangedPaths(paths: readonly string[]): ChangedPathSummary {
  const categories: ChangedPathSummary["categories"] = {
    source: 0,
    test: 0,
    docs: 0,
    config: 0,
    other: 0
  };
  const directories = new Map<string, number>();
  let excludedFileCount = 0;
  let changedFileCount = 0;
  for (const rawPath of paths) {
    const path = rawPath.trim().replaceAll("\\", "/");
    if (path === "") continue;
    if (path === ".harness" || path.startsWith(".harness/")) {
      excludedFileCount += 1;
      continue;
    }
    changedFileCount += 1;
    categories[categoryOf(path)] += 1;
    const top = path.includes("/") ? path.slice(0, path.indexOf("/")) : ".";
    directories.set(top, (directories.get(top) ?? 0) + 1);
  }
  const topDirectories = [...directories.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([path, files]) => ({ path, files }));
  return { changedFileCount, excludedFileCount, categories, topDirectories };
}

async function runGit(root: string, args: readonly string[]): Promise<GitResult> {
  return await new Promise((resolveResult) => {
    const child = spawn("git", args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let stdout = "";
    let truncated = false;
    const limit = 2 * 1024 * 1024;
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length + chunk.length <= limit) {
        stdout += chunk;
      } else {
        stdout += chunk.slice(0, Math.max(0, limit - stdout.length));
        truncated = true;
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolveResult({ code: 1, stdout, truncated });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveResult({ code: code ?? 1, stdout, truncated });
    });
  });
}

export async function observeGitDelta(root: string): Promise<GitDeltaObservation> {
  const headResult = await runGit(root, ["rev-parse", "HEAD"]);
  const headCommit = headResult.code === 0 && /^[a-f0-9]{40}$/i.test(headResult.stdout.trim())
    ? headResult.stdout.trim()
    : null;
  let baselineCommit: string | null = null;
  let baselineSource: GitDeltaObservation["baselineSource"] = "none";
  if (headCommit !== null) {
    const upstream = await runGit(root, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}"
    ]);
    if (upstream.code === 0 && upstream.stdout.trim() !== "") {
      const mergeBase = await runGit(root, [
        "merge-base",
        headCommit,
        upstream.stdout.trim()
      ]);
      if (mergeBase.code === 0 && /^[a-f0-9]{40}$/i.test(mergeBase.stdout.trim())) {
        baselineCommit = mergeBase.stdout.trim();
        baselineSource = "upstream-merge-base";
      }
    }
  }
  if (headCommit === null || baselineCommit === null || baselineCommit === headCommit) {
    return {
      headCommit,
      baselineCommit,
      baselineSource,
      shortstat: baselineCommit === headCommit && headCommit !== null ? "0 files changed" : null,
      truncated: false,
      ...summarizeChangedPaths([])
    };
  }
  const range = `${baselineCommit}..${headCommit}`;
  const [shortstat, names] = await Promise.all([
    runGit(root, ["diff", "--shortstat", range]),
    runGit(root, ["diff", "--name-only", range])
  ]);
  return {
    headCommit,
    baselineCommit,
    baselineSource,
    shortstat: shortstat.code === 0 ? shortstat.stdout.trim() || "0 files changed" : null,
    truncated: shortstat.truncated || names.truncated,
    ...summarizeChangedPaths(names.code === 0 ? names.stdout.split(/\r?\n/) : [])
  };
}
