import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertWorkspaceSourcesBoundToCheckout,
  workspaceSourceAliases
} from "./bundle-workspace-sources.mjs";

const cwd = process.cwd();
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  (await readFile(join(cwd, "package.json"), "utf8")).replace(/^\uFEFF/, "")
);
const requireFromWorkspace = createRequire(join(cwd, "package.json"));
const { build } = requireFromWorkspace("esbuild");

const externals = packageJson.name === "@hunter-harness/skill-cli"
  ? ["adm-zip", "commander", "yaml", "zod", "pacote"]
  : ["commander", "yaml", "zod", "pacote"];

const result = await build({
  entryPoints: [join(cwd, "src", "bin.ts")],
  absWorkingDir: repositoryRoot,
  alias: workspaceSourceAliases(repositoryRoot),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: externals,
  outfile: join(cwd, "dist", "bin.js"),
  metafile: true
});
assertWorkspaceSourcesBoundToCheckout(repositoryRoot, result.metafile);
