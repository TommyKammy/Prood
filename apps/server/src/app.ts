import { Hono } from "hono";
import {
  createHealthCheckUseCase,
  type Clock,
  type DatabaseHealthPort,
} from "@prood/application";
import type { LocaleCode } from "@prood/domain";

export interface AppDeps {
  clock: Clock;
  dbHealth: DatabaseHealthPort;
  locale?: LocaleCode;
}

/**
 * Web-Standard Hono application with zero Node-specific or DB-driver imports
 * so the HTTP layer can also run on Cloudflare Workers.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const getHealth = createHealthCheckUseCase(deps);

  app.get("/healthz", async (c) => {
    const health = await getHealth();
    return c.json({ status: health.status, dbDriver: health.dbDriver });
  });

  app.get("/api/v1/health", async (c) => {
    const health = await getHealth();
    return c.json(health);
  });

  return app;
}
