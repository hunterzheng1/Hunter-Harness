import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { createServer } from "./app.js";
import { runMigrations } from "./repositories/migrate.js";
import { PostgresRepository } from "./repositories/postgres.js";
import { LocalArtifactStorage } from "./storage/local.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(name + " is required");
  }
  return value;
}

const databaseUrl = required("DATABASE_URL");
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
const bootstrapToken = process.env.HUNTER_HARNESS_BOOTSTRAP_TOKEN;
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
