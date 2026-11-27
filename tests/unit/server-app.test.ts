import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION } from "@prood/contracts";
import { createApp } from "@prood/server/app";

describe("@prood/server Web-Standard app", () => {
  it("handles /healthz and /api/v1/health via Fetch Request/Response without Node HTTP", async () => {
    const app = createApp({
      clock: { now: () => new Date("2026-11-27T09:00:00.000Z") },
      dbHealth: {
        driver: "sqlite",
        ping: async () => ({ ok: true }),
      },
    });

    const healthzRes = await app.request("/healthz");
    expect(healthzRes.status).toBe(200);
    expect(await healthzRes.json()).toEqual({
      status: "ok",
      dbDriver: "sqlite",
    });

    const apiRes = await app.request("/api/v1/health");
    expect(apiRes.status).toBe(200);
    expect(await apiRes.json()).toEqual({
      contractVersion: CONTRACT_VERSION,
      status: "ok",
      dbDriver: "sqlite",
      locale: "en",
      timestamp: "2026-11-27T09:00:00.000Z",
    });
  });
});
