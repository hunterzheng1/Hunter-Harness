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
const bundlesRoot = join(root, "resources", "harness", "bundles");
const manifestsRoot = join(root, "resources", "harness", "manifests");

function parseArgs(argv) {
  const options = {
    family: "harness",
    server: "http://127.0.0.1:8787",
    token: process.env.HUNTER_HARNESS_TOKEN ?? "",
    profiles: ["general", "java"],
    sync: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--family") options.family = argv[++i] ?? options.family;
    else if (arg === "--server") options.server = argv[++i] ?? options.server;
    else if (arg === "--token") options.token = argv[++i] ?? options.token;
    else if (arg === "--profile") options.profiles = [argv[++i] ?? "general"];
    else if (arg === "--sync") options.sync = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/upload-workflow.mjs [--family harness] [--server URL] [--token TOKEN] [--profile general|java] [--sync]\n"
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

async function buildProfileZip(profile) {
  const zip = new AdmZip();
  const bundleDir = join(bundlesRoot, profile);
  const manifestDir = join(manifestsRoot, profile);
  for (const item of await filesUnder(bundleDir)) {
    zip.addFile(join(profile, item.path).replaceAll("\\", "/"), await readFile(item.full));
  }
  for (const item of await filesUnder(manifestDir)) {
    zip.addFile(join("manifests", item.path).replaceAll("\\", "/"), await readFile(item.full));
  }
  return zip.toBuffer();
}

async function uploadProfile({ family, server, token, profile, zipBytes }) {
  const boundary = "----upload-workflow-" + randomUUID();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${profile}.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    zipBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const response = await fetch(`${server.replace(/\/$/, "")}/api/v1/workflow-families/${encodeURIComponent(family)}/draft/profiles/${encodeURIComponent(profile)}`, {
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
    throw new Error(`upload ${profile} failed (${response.status}): ${text}`);
  }
  process.stdout.write(`uploaded ${family}/${profile}\n`);
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

for (const profile of options.profiles) {
  const zipBytes = await buildProfileZip(profile);
  await uploadProfile({ ...options, profile, zipBytes });
}

process.stdout.write(`workflow family draft updated: ${options.family}\n`);
