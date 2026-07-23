#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const marker = join(root, ".harness", "check-ok.marker");
const maxAgeMs = 10 * 60 * 1000;
const expectedCommand = "npm run check";

function git(...args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function writeMarker() {
  const treeHash = git("write-tree");
  if (treeHash === null || treeHash === "") return 1;
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({
    ts: Date.now() / 1000,
    treeHash,
    command: expectedCommand
  }) + "\n", "utf8");
  process.stdout.write(`check-ok marker written for tree ${treeHash.slice(0, 7)}\n`);
  return 0;
}

async function checkMarker() {
  let value;
  try {
    value = JSON.parse(await readFile(marker, "utf8"));
  } catch {
    return 1;
  }
  const ageMs = Date.now() - Number(value.ts) * 1000;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) return 1;
  if (value.command !== expectedCommand || typeof value.treeHash !== "string") {
    return 1;
  }
  const headTree = git("rev-parse", "HEAD^{tree}");
  if (headTree === null || headTree !== value.treeHash) return 1;
  process.stdout.write(
    `pre-push: skipping npm run check (verified ${Math.floor(ageMs / 1000)}s ago ` +
    `for tree ${headTree.slice(0, 7)})\n`
  );
  return 0;
}

const exitCode = process.argv.includes("--write")
  ? await writeMarker()
  : await checkMarker();
process.exitCode = exitCode;
