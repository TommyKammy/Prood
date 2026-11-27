import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSystemIdGenerator } from "@prood/application";
import { createBetterAuthAdapter } from "@prood/integration-better-auth";
import type { KyselyBackedDatabaseClient } from "@prood/persistence-common";
import { createPostgresDatabase } from "@prood/persistence-postgres";
import { createSqliteDatabase } from "@prood/persistence-sqlite";
import { createApp } from "./app.js";

export { createApp, type AppDeps } from "./app.js";

export function selectDatabaseClient(
  env: NodeJS.ProcessEnv = process.env,
): KyselyBackedDatabaseClient {
  const driver = env.PROOD_DB_DRIVER ?? (env.DATABASE_URL ? "postgres" : "sqlite");
  if (driver === "postgres") {
    const url = env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is required when PROOD_DB_DRIVER=postgres");
    }
    return createPostgresDatabase({ connectionString: url });
  }
  if (driver === "sqlite") {
    const dbPath = env.PROOD_SQLITE_PATH ?? resolve(process.cwd(), "prood.sqlite");
    return createSqliteDatabase({ filePath: dbPath });
  }
  throw new Error(`Unsupported PROOD_DB_DRIVER: ${driver}`);
}

function mountWebShellAssets(rootApp: Hono): void {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const webDistDir = resolve(currentDir, "../../web/dist");

  const assets: Array<{ route: string; file: string; contentType: string }> = [
    { route: "/", file: "index.html", contentType: "text/html; charset=utf-8" },
    {
      route: "/shell.js",
      file: "shell.js",
      contentType: "application/javascript; charset=utf-8",
    },
    { route: "/shell.css", file: "shell.css", contentType: "text/css; charset=utf-8" },
  ];

  for (const asset of assets) {
    rootApp.get(asset.route, (c) => {
      const fullPath = resolve(webDistDir, asset.file);
      if (!existsSync(fullPath)) {
        return c.text("Web assets not built. Run pnpm build:web.", 404);
      }
      return c.body(readFileSync(fullPath), 200, {
        "Content-Type": asset.contentType,
      });
    });
  }
}

export async function startNodeServer(): Promise<void> {
  const db = selectDatabaseClient();
  await db.migrate();

  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const baseURL = process.env.PROOD_BASE_URL ?? `http://127.0.0.1:${port}`;
  const secret =
    process.env.PROOD_AUTH_SECRET ?? "prood-dev-secret-change-in-production-32";

  const auth = createBetterAuthAdapter({
    db,
    secret,
    baseURL,
    trustedOrigins: [baseURL],
  });

  const apiApp = createApp({
    clock: { now: () => new Date() },
    dbHealth: db,
    auth,
    uow: db.uow,
    idGenerator: createSystemIdGenerator(),
  });

  const rootApp = new Hono();
  rootApp.route("/", apiApp);
  mountWebShellAssets(rootApp);

  serve({ fetch: rootApp.fetch, port }, () => {
    console.log(`Prood server listening on ${baseURL} (${db.driver})`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void startNodeServer();
}
