import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { DbSmokeAdapter } from "@prood/persistence-common";
import { createPostgresSmokeAdapter } from "@prood/persistence-postgres";
import { createSqliteSmokeAdapter } from "@prood/persistence-sqlite";
import { createApp } from "./app.js";

export { createApp, type AppDeps } from "./app.js";

export function selectPersistenceAdapter(env: NodeJS.ProcessEnv = process.env): DbSmokeAdapter {
  const driver = env.PROOD_DB_DRIVER ?? (env.DATABASE_URL ? "postgres" : "sqlite");
  if (driver === "postgres") {
    const url = env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is required when PROOD_DB_DRIVER=postgres");
    }
    return createPostgresSmokeAdapter(url);
  }
  if (driver === "sqlite") {
    const dbPath = env.PROOD_SQLITE_PATH ?? resolve(process.cwd(), "prood.sqlite");
    return createSqliteSmokeAdapter(dbPath);
  }
  throw new Error(`Unsupported PROOD_DB_DRIVER: ${driver}`);
}

export function startNodeServer(): void {
  const adapter = selectPersistenceAdapter();
  const app = createApp({
    clock: { now: () => new Date() },
    dbHealth: adapter,
  });
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Prood server listening on http://127.0.0.1:${port} (${adapter.driver})`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startNodeServer();
}
