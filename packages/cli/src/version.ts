import { readFile } from "node:fs/promises";

let cachedVersion: string | null = null;

export async function readCliVersion(): Promise<string> {
  if (cachedVersion !== null) return cachedVersion;
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("CLI package version is missing");
  }
  cachedVersion = packageJson.version;
  return cachedVersion;
}
