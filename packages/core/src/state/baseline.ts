import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  baselineManifestSchema,
  type BaselineManifest
} from "@hunter-harness/contracts";

import { atomicWriteJson } from "./atomic.js";
import { ensureStateLayout, stateLayout } from "./layout.js";

export async function writeBaseline(
  projectRoot: string,
  baseline: BaselineManifest
): Promise<void> {
  const parsed = baselineManifestSchema.parse(baseline);
  const layout = await ensureStateLayout(projectRoot);
  await atomicWriteJson(join(layout.baseline, "manifest.json"), parsed);
}

export async function readBaseline(projectRoot: string): Promise<BaselineManifest> {
  const content = await readFile(
    join(stateLayout(projectRoot).baseline, "manifest.json"),
    "utf8"
  );
  return baselineManifestSchema.parse(JSON.parse(content));
}
