import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const resourcesRoot = fileURLToPath(
  new URL("../packages/workflow-data-harness", import.meta.url)
);

const root = await mkdtemp(join(tmpdir(), "hunter-seed-size-"));
const env = { ...process.env, HUNTER_HARNESS_RECOVERY_ROOT: join(tmpdir(), "hunter-seed-recovery") };
const t0 = Date.now();
const out = execFileSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "--maxWorkers=1", "--project", "integration", "packages/cli/test/init.test.ts"],
  { cwd: process.cwd(), env, encoding: "utf8" }
);
console.log("init.test.ts done", Date.now() - t0, "ms");
await rm(root, { recursive: true, force: true });
