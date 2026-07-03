import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import { createServer } from "./app.js";
import { PgAiJobStore } from "./ai/ai-job-store-pg.js";
import { PostgresRegistryPersistence } from "./registry/persistence.js";
import { runMigrations } from "./repositories/migrate.js";
import { PostgresRepository } from "./repositories/postgres.js";
import { LocalArtifactStorage } from "./storage/local.js";

async function secret(name: string, required: boolean): Promise<string | undefined> {
  const value = process.env[name];
  if (value !== undefined && value.trim() !== "") {
    return value.trim();
  }
  const file = process.env[name + "_FILE"];
  if (file !== undefined && file.trim() !== "") {
    const fileValue = (await readFile(file, "utf8")).trim();
    if (fileValue !== "") return fileValue;
  }
  if (required) {
    throw new Error(name + " is required");
  }
  return undefined;
}

const databaseUrl = await secret("DATABASE_URL", true);
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const artifactRoot = process.env.ARTIFACT_ROOT ?? "/var/lib/hunter-harness/artifacts";
const pool = new Pool({
  connectionString: databaseUrl,
  ...(process.env.DATABASE_SSL === "require"
    ? { ssl: { rejectUnauthorized: true } }
    : {})
});
await runMigrations(
  pool,
  fileURLToPath(new URL("../migrations", import.meta.url))
);
const repository = new PostgresRepository(pool);
const bootstrapManifest = JSON.parse(
  await readFile(fileURLToPath(new URL("../../../resources/bootstrap-ir/manifest.json", import.meta.url)), "utf8")
) as { registry_version: string; compiler_version: string };
// 新模型：bootstrap skills 从 resources/skills/<name>/ 加载（任务 18 转换后）；
// 此处暂只读 manifest（registry_version/compiler_version），skills 留空，等 resources/skills/ 就绪后扩展。
const bootstrapBundle = {
  registryVersion: bootstrapManifest.registry_version,
  compilerVersion: bootstrapManifest.compiler_version,
  skills: []
};
const bootstrapToken = await secret("HUNTER_HARNESS_BOOTSTRAP_TOKEN", false);
if (bootstrapToken !== undefined && bootstrapToken !== "") {
  await repository.createActorWithToken({
    actorId: process.env.HUNTER_HARNESS_BOOTSTRAP_ACTOR ?? "actor_owner",
    displayName: process.env.HUNTER_HARNESS_BOOTSTRAP_NAME ?? "Owner",
    label: "environment-bootstrap",
    token: bootstrapToken
  });
}

const app = await createServer({
  repository,
  storage: new LocalArtifactStorage(artifactRoot),
  bootstrapBundle,
  registryPersistence: new PostgresRegistryPersistence(pool),
  aiJobStore: new PgAiJobStore(pool),
  logger: true
});
const port = Number(process.env.PORT ?? "3001");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
await app.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await pool.end();
}
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
