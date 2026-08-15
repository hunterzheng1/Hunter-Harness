import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

const args = process.argv.slice(2);
const platformFlag = args.indexOf("--platform-root");
if (platformFlag < 0 || !args[platformFlag + 1]) {
  process.stderr.write(`${JSON.stringify({ ok: false, reason_code: "platform_root_required" })}\n`);
  process.exit(2);
}

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const platformRoot = resolve(args[platformFlag + 1]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifacts = [
  ["source", "packages/contracts/src/platform-information-export.ts", "packages/contracts/src/platform-information-export.ts"],
  ["test", "packages/contracts/test/platform-information-export-contracts.test.ts", "packages/contracts/test/platform-information-export-contracts.test.ts"],
  ["current_fixture", "packages/contracts/test/fixtures/platform-information-export-v1-current.json", "packages/contracts/test/fixtures/platform-information-export-v1-current.json"],
  ["legacy_fixture", "packages/contracts/test/fixtures/platform-information-export-v0-legacy.json", "packages/contracts/test/fixtures/platform-information-export-v0-legacy.json"],
  ["jsonl_fixture", "packages/contracts/test/fixtures/platform-information-export-canonical-v1-current.jsonl", "packages/contracts/test/fixtures/platform-information-export-canonical-v1-current.jsonl"],
  ["openapi", "packages/contracts/openapi/hunter-harness-v1.yaml", "apps/server/openapi/hunter-harness-v1.yaml"],
  ["openapi_sidecar", "packages/contracts/openapi/hunter-harness-v1.yaml.sha256", "apps/server/openapi/hunter-harness-v1.yaml.sha256"],
  ["generated_declaration", "packages/contracts/dist/platform-information-export.d.ts", "packages/contracts/dist/platform-information-export.d.ts"],
];

const hashes = {};
for (const [name, harnessPath, platformPath] of artifacts) {
  let harnessBytes;
  let platformBytes;
  try {
    harnessBytes = await readFile(resolve(harnessRoot, harnessPath));
    platformBytes = await readFile(resolve(platformRoot, platformPath));
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, reason_code: "artifact_missing", artifact: name })}\n`);
    process.exit(1);
  }
  const harnessSha = digest(harnessBytes);
  const platformSha = digest(platformBytes);
  if (!harnessBytes.equals(platformBytes)) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      reason_code: "artifact_byte_drift",
      artifact: name,
      harness_sha256: harnessSha,
      platform_sha256: platformSha,
    })}\n`);
    process.exit(1);
  }
  hashes[name] = harnessSha;
}

for (const [root, openapiPath, sidecarPath] of [
  [harnessRoot, "packages/contracts/openapi/hunter-harness-v1.yaml", "packages/contracts/openapi/hunter-harness-v1.yaml.sha256"],
  [platformRoot, "apps/server/openapi/hunter-harness-v1.yaml", "apps/server/openapi/hunter-harness-v1.yaml.sha256"],
]) {
  const openapi = await readFile(resolve(root, openapiPath));
  const sidecar = (await readFile(resolve(root, sidecarPath), "utf8")).trim();
  if (!/^[a-f0-9]{64}$/u.test(sidecar) || sidecar !== digest(openapi)) {
    process.stderr.write(`${JSON.stringify({ ok: false, reason_code: "openapi_sidecar_mismatch", root })}\n`);
    process.exit(1);
  }
}

const openapi = parseYaml(await readFile(resolve(
  harnessRoot,
  "packages/contracts/openapi/hunter-harness-v1.yaml",
), "utf8"));
const schemas = openapi?.components?.schemas ?? {};
const requiredSchemas = [
  "PlatformInformationExportRange",
  "PlatformInformationExportPageProof",
  "PlatformInformationExportM4Proof",
  "PlatformInformationExportArtifactSummary",
  "PlatformInformationExportDownloadRef",
  "PlatformInformationExportArtifactReceipt",
  "PlatformInformationExportManifestLine",
  "PlatformInformationExportItemLine",
  "PlatformInformationExportFooterLine",
  "PlatformInformationExportJsonlLine",
  "LegacyPlatformInformationExportArtifactReceipt",
];
if (requiredSchemas.some((name) => !schemas[name]) ||
    schemas.PlatformInformationExportArtifactSummary?.properties?.byte_count?.maximum !== 536870912 ||
    schemas.PlatformInformationExportArtifactSummary?.properties?.item_count?.maximum !== 1000000 ||
    schemas.PlatformInformationExportArtifactSummary?.properties?.page_count?.maximum !== 10000 ||
    !schemas.PlatformInformationExportM4Proof?.required?.includes("items_sha") ||
    schemas.PlatformInformationExportM4Proof?.properties?.items_sha?.pattern !== "^sha256:[a-f0-9]{64}$" ||
    schemas.PlatformInformationExportArtifactReceipt?.properties?.status?.const !== "ready" ||
    schemas.PlatformInformationExportArtifactSummary?.properties?.media_type?.const !== "application/x-ndjson") {
  process.stderr.write(`${JSON.stringify({ ok: false, reason_code: "openapi_export_schema_drift" })}\n`);
  process.exit(1);
}

const source = await readFile(resolve(
  harnessRoot,
  "packages/contracts/src/platform-information-export.ts",
), "utf8");
if (/from\s+["']node:/u.test(source)) {
  process.stderr.write(`${JSON.stringify({ ok: false, reason_code: "browser_contract_imports_node_runtime" })}\n`);
  process.exit(1);
}
for (const root of [harnessRoot, platformRoot]) {
  const indexSource = await readFile(resolve(root, "packages/contracts/src/index.ts"), "utf8");
  const indexDeclaration = await readFile(resolve(root, "packages/contracts/dist/index.d.ts"), "utf8");
  if (!indexSource.includes('export * from "./platform-information-export.js";') ||
      !indexDeclaration.includes('export * from "./platform-information-export.js";')) {
    process.stderr.write(`${JSON.stringify({ ok: false, reason_code: "export_entrypoint_missing", root })}\n`);
    process.exit(1);
  }
}

const harnessModule = await import(`${pathToFileURL(resolve(
  harnessRoot,
  "packages/contracts/dist/platform-information-export.js",
)).href}?parity=${Date.now()}`);
const platformModule = await import(`${pathToFileURL(resolve(
  platformRoot,
  "packages/contracts/dist/platform-information-export.js",
)).href}?parity=${Date.now()}`);
const current = await readFile(resolve(
  harnessRoot,
  "packages/contracts/test/fixtures/platform-information-export-v1-current.json",
), "utf8");
const legacy = await readFile(resolve(
  harnessRoot,
  "packages/contracts/test/fixtures/platform-information-export-v0-legacy.json",
), "utf8");
const artifact = new Uint8Array(await readFile(resolve(
  harnessRoot,
  "packages/contracts/test/fixtures/platform-information-export-canonical-v1-current.jsonl",
)));

class NodeHashSession {
  #hash = createHash("sha256");
  update(chunk) { this.#hash.update(chunk); }
  digest() { return `sha256:${this.#hash.digest("hex")}`; }
}
const hashPort = {
  create_sha256: () => new NodeHashSession(),
  sha256: (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
};
const reader = (bytes) => {
  let offset = 0;
  return {
    read() {
      if (offset === bytes.byteLength) return null;
      const chunk = bytes.slice(offset, Math.min(offset + 17, bytes.byteLength));
      offset += chunk.byteLength;
      return chunk;
    },
  };
};

const matrix = [
  ["current", current],
  ["legacy", legacy],
  ["unknown", JSON.stringify({ schema_version: 9 })],
  ["hostile", JSON.stringify({ schema_version: 1, contract_kind: "platform_information_export_artifact_receipt", extra: true })],
];
for (const [name, serialized] of matrix) {
  const harnessResult = harnessModule.readPlatformInformationExportArtifactReceipt(serialized);
  const platformResult = platformModule.readPlatformInformationExportArtifactReceipt(serialized);
  if (JSON.stringify(harnessResult) !== JSON.stringify(platformResult)) {
    process.stderr.write(`${JSON.stringify({ ok: false, reason_code: "runtime_reader_drift", case: name })}\n`);
    process.exit(1);
  }
}
const harnessVerification = await harnessModule.verifyPlatformInformationExportArtifact(current, {
  hash_port: hashPort,
  chunk_reader: reader(artifact),
});
const platformVerification = await platformModule.verifyPlatformInformationExportArtifact(current, {
  hash_port: hashPort,
  chunk_reader: reader(artifact),
});
if (!harnessVerification.ok || JSON.stringify(harnessVerification) !== JSON.stringify(platformVerification)) {
  process.stderr.write(`${JSON.stringify({ ok: false, reason_code: "runtime_verifier_drift" })}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  contract: "platform_information_export_artifact_v1",
  byte_parity_artifacts: artifacts.length,
  runtime_parity_cases: matrix.length + 1,
  hashes,
})}\n`);
