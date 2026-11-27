import { getRequestListener, serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSystemIdGenerator,
  createWorkUseCases,
} from "@prood/application";
import { createBetterAuthAdapter } from "@prood/integration-better-auth";
import { createProodMcpServer } from "@prood/integration-fastmcp";
import type { KyselyBackedDatabaseClient } from "@prood/persistence-common";
import { createPostgresDatabase } from "@prood/persistence-postgres";
import { createSqliteDatabase } from "@prood/persistence-sqlite";
import { createApp } from "./app.js";

export { createApp, type AppDeps } from "./app.js";

const DEV_FALLBACK_AUTH_SECRET = "prood-dev-secret-change-in-production-32";

export interface ServerConfig {
  port: number;
  hostname: string;
  baseURL: string;
  secret: string;
  mcpResource: string;
}

export function resolveServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const rawPort = env.PORT ?? "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`Invalid PORT: ${rawPort}`);
  }

  const rawHost = env.HOST?.trim() || "127.0.0.1";
  const hostname =
    rawHost.startsWith("[") && rawHost.endsWith("]")
      ? rawHost.slice(1, -1)
      : rawHost;
  const urlHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  const baseURL = (env.PROOD_BASE_URL ?? `http://${urlHost}:${port}`).replace(
    /\/+$/,
    "",
  );
  new URL(baseURL);
  const mcpResource = `${baseURL}/mcp`;

  const rawSecret = env.PROOD_AUTH_SECRET;
  const isProduction = env.NODE_ENV === "production";
  let secret: string;
  if (rawSecret !== undefined) {
    if (rawSecret.trim().length < 32) {
      throw new Error(
        "PROOD_AUTH_SECRET must be at least 32 characters when configured",
      );
    }
    secret = rawSecret;
  } else if (isProduction) {
    throw new Error(
      "PROOD_AUTH_SECRET (>= 32 chars) is required when NODE_ENV=production",
    );
  } else {
    secret = DEV_FALLBACK_AUTH_SECRET;
  }

  return {
    port,
    hostname,
    baseURL,
    secret,
    mcpResource,
  };
}

export function createNodeAppListener(app: Hono) {
  return getRequestListener(app.fetch);
}

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

export function mountWebShellAssets(rootApp: Hono, customWebDistDir?: string): void {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const webDistDir = customWebDistDir ?? resolve(currentDir, "../../web/dist");

  const assets: Array<{
    route: string;
    file: string;
    contentType: string;
    isHtml: boolean;
  }> = [
    {
      route: "/",
      file: "index.html",
      contentType: "text/html; charset=utf-8",
      isHtml: true,
    },
    {
      route: "/oauth/consent",
      file: "index.html",
      contentType: "text/html; charset=utf-8",
      isHtml: true,
    },
    {
      route: "/oauth/consent/",
      file: "index.html",
      contentType: "text/html; charset=utf-8",
      isHtml: true,
    },
    {
      route: "/shell.js",
      file: "shell.js",
      contentType: "application/javascript; charset=utf-8",
      isHtml: false,
    },
    {
      route: "/shell.css",
      file: "shell.css",
      contentType: "text/css; charset=utf-8",
      isHtml: false,
    },
  ];

  for (const asset of assets) {
    rootApp.get(asset.route, (c) => {
      const fullPath = resolve(webDistDir, asset.file);
      if (!existsSync(fullPath)) {
        return c.text("Web assets not built. Run pnpm build:web.", 404);
      }
      const headers: Record<string, string> = {
        "Content-Type": asset.contentType,
        "X-Content-Type-Options": "nosniff",
      };
      if (asset.isHtml) {
        headers["X-Frame-Options"] = "DENY";
        headers["Content-Security-Policy"] =
          "default-src 'self'; frame-ancestors 'none'";
        headers["Referrer-Policy"] = "no-referrer";
        headers["Cache-Control"] = "no-store";
      }
      return c.body(readFileSync(fullPath), 200, headers);
    });
  }
}

export interface ShutdownServerOptions {
  server: {
    close(callback: () => void): unknown;
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
  };
  closeMcp?: () => Promise<void>;
  closeDb: () => Promise<void>;
  timeoutMs?: number;
}

/**
 * Initiates HTTP closure, terminates active MCP SSE streams so server.close()
 * can drain cleanly, enforces a bounded fallback timeout, and closes the DB.
 */
export async function shutdownServerResources(
  options: ShutdownServerOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const serverClosed = new Promise<void>((resolveClose) => {
    options.server.close(() => resolveClose());
  });

  if (options.closeMcp) {
    await Promise.allSettled([options.closeMcp()]);
  }
  options.server.closeIdleConnections?.();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      serverClosed,
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(() => {
          timedOut = true;
          options.server.closeAllConnections?.();
          resolveTimeout();
        }, timeoutMs);
        if (typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }
      }),
    ]);
    if (timedOut) {
      await Promise.race([
        serverClosed,
        new Promise<void>((r) => setTimeout(r, 50)),
      ]);
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  await Promise.allSettled([options.closeDb()]);
}

export async function startNodeServer(): Promise<void> {
  const config = resolveServerConfig();
  const db = selectDatabaseClient();
  await db.migrate();

  const origin = new URL(config.baseURL).origin;
  const auth = createBetterAuthAdapter({
    db,
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [origin],
    mcpResource: config.mcpResource,
  });

  const clock = { now: () => new Date() };
  const idGenerator = createSystemIdGenerator();
  const workUseCases = createWorkUseCases({
    uow: db.uow,
    idGenerator,
    clock,
  });

  const mcpHandler = createProodMcpServer({
    resource: config.mcpResource,
    tokenVerifier: auth,
    uow: db.uow,
    idGenerator,
    clock,
    trustedOrigins: [origin],
    onAuthFailure: (info) =>
      workUseCases.recordEntryAuthFailure({
        channel: "mcp",
        path: info.path,
        reasonCode: info.reasonCode,
        detail: info.detail,
      }),
  });

  const apiApp = createApp({
    clock,
    dbHealth: db,
    auth,
    uow: db.uow,
    idGenerator,
    mcpAuth: auth,
    mcpHandler,
  });

  const rootApp = new Hono();
  rootApp.route("/", apiApp);
  mountWebShellAssets(rootApp);

  const server = serve(
    { fetch: rootApp.fetch, port: config.port, hostname: config.hostname },
    () => {
      console.log(`Prood server listening on ${config.baseURL} (${db.driver})`);
    },
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await shutdownServerResources({
      server,
      closeMcp: mcpHandler.close,
      closeDb: () => db.close(),
    });
  };

  process.once("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void startNodeServer();
}
