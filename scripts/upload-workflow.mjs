#!/usr/bin/env node
/* global fetch */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { randomUUID } from "node:crypto";

import AdmZip from "adm-zip";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowDataRoot = join(root, "packages", "workflow-data-harness", "harness");
const bundlesRoot = join(workflowDataRoot, "bundles");
const manifestsRoot = join(workflowDataRoot, "manifests");

function parseArgs(argv) {
  const options = {
    family: "harness",
    server: "http://127.0.0.1:8787",
    token: process.env.HUNTER_HARNESS_TOKEN ?? "",
    sync: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--family") options.family = argv[++i] ?? options.family;
    else if (arg === "--server") options.server = argv[++i] ?? options.server;
    else if (arg === "--token") options.token = argv[++i] ?? options.token;
    else if (arg === "--sync") options.sync = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/upload-workflow.mjs [--family harness] [--server URL] [--token TOKEN] [--sync]\n"
      );
      process.exit(0);
    }
  }
  return options;
}

async function filesUnder(directory, base = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(full, base));
    if (entry.isFile()) result.push({ path: relative(base, full).replaceAll("\\", "/"), full });
  }
  return result;
}

// v1.0：单 bundle 已拍平（bundles/<surface>/ + manifests/<surface>.json），
// profile 维度退役；服务端仍按 profile=general 通道接收草稿。
async function buildBundleZip() {
  const zip = new AdmZip();
  for (const item of await filesUnder(bundlesRoot)) {
    zip.addFile(join("bundles", item.path).replaceAll("\\", "/"), await readFile(item.full));
  }
  for (const item of await filesUnder(manifestsRoot)) {
    zip.addFile(join("manifests", item.path).replaceAll("\\", "/"), await readFile(item.full));
  }
  return zip.toBuffer();
}

async function uploadBundle({ family, server, token, zipBytes }) {
  const boundary = "----upload-workflow-" + randomUUID();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="harness.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    zipBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  // 服务端 profile 维度退役由 hunter-platform 配套计划执行；落地前仍走 general 通道。
  const response = await fetch(`${server.replace(/\/$/, "")}/api/v1/workflow-families/${encodeURIComponent(family)}/draft/profiles/general`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "idempotency-key": randomUUID(),
      "x-request-id": randomUUID()
    },
    body
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`upload failed (${response.status}): ${text}`);
  }
  process.stdout.write(`uploaded ${family}\n`);
}

const options = parseArgs(process.argv.slice(2));
if (options.sync) {
  const sync = spawnSync(process.execPath, [join(root, "scripts", "sync-harness.mjs")], { stdio: "inherit", cwd: root });
  if (sync.status !== 0) process.exit(sync.status ?? 1);
}
if (options.token === "") {
  process.stderr.write("HUNTER_HARNESS_TOKEN or --token is required\n");
  process.exit(1);
}

const zipBytes = await buildBundleZip();
await uploadBundle({ ...options, zipBytes });

process.stdout.write(`workflow family draft updated: ${options.family}\n`);
