import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const cwd = process.cwd();
const packageJson = JSON.parse(
  (await readFile(join(cwd, "package.json"), "utf8")).replace(/^\uFEFF/, "")
);
const requireFromWorkspace = createRequire(join(cwd, "package.json"));
const { build } = requireFromWorkspace("esbuild");

const externals = packageJson.name === "@hunter-harness/skill-cli"
  ? ["adm-zip", "commander", "yaml", "zod", "pacote"]
  : ["commander", "yaml", "zod", "pacote"];

await build({
  entryPoints: [join(cwd, "src", "bin.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: externals,
  outfile: join(cwd, "dist", "bin.js")
});
