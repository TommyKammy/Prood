import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthPort, AuthSessionInfo, UnitOfWork } from "@prood/application";
import { CONTRACT_VERSION } from "@prood/contracts";
import { generateEntityId } from "@prood/domain";
import {
  createApp,
  mountWebShellAssets,
  resolveServerConfig,
} from "@prood/server";

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

  it("enforces auth on /api/v1/me and workspace membership checks via AuthPort", async () => {
    const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(1));
    const wksB = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
    const usr1 = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(3));
    const mbr1 = generateEntityId("mbr", 1_795_000_000_000, new Uint8Array(10).fill(4));

    const validSession: AuthSessionInfo = {
      sessionId: "sess_1",
      authProvider: "better-auth",
      authSubject: "ba_user_1",
      email: "alice@example.com",
      name: "Alice",
      expiresAt: "2026-12-01T00:00:00.000Z",
    };

    const mockAuth: AuthPort = {
      handler: async () => new Response("ok"),
      getSession: async (headers) =>
        headers.get("authorization") === "Bearer valid" ? validSession : null,
    };

    const mockUow: UnitOfWork = {
      run: async (fn) =>
        fn({
          workspaces: {
            create: async () => {
              throw new Error("not implemented");
            },
            findById: async (id) =>
              id === wksA
                ? {
                    id: wksA,
                    slug: "alpha",
                    name: "Alpha",
                    createdAt: "2026-11-27T00:00:00.000Z",
                    updatedAt: "2026-11-27T00:00:00.000Z",
                  }
                : null,
            findBySlug: async () => null,
            updateName: async () => null,
          },
          workspaceSettings: {
            upsert: async () => {
              throw new Error("not implemented");
            },
            findByWorkspaceId: async () => null,
          },
          users: {
            findById: async () => null,
            findByEmail: async () => null,
            findByAuthIdentity: async () => ({
              id: usr1,
              email: "alice@example.com",
              displayName: "Alice",
              createdAt: "2026-11-27T00:00:00.000Z",
              updatedAt: "2026-11-27T00:00:00.000Z",
            }),
            create: async () => {
              throw new Error("not implemented");
            },
            linkAuthIdentity: async () => {
              throw new Error("not implemented");
            },
          },
          memberships: {
            create: async () => {
              throw new Error("not implemented");
            },
            findByWorkspaceAndUser: async (wsId, userId) =>
              wsId === wksA && userId === usr1
                ? {
                    id: mbr1,
                    workspaceId: wksA,
                    userId: usr1,
                    role: "admin",
                    createdAt: "2026-11-27T00:00:00.000Z",
                    updatedAt: "2026-11-27T00:00:00.000Z",
                  }
                : null,
            listSummariesForUser: async () => [
              {
                membershipId: mbr1,
                workspaceId: wksA,
                workspaceSlug: "alpha",
                workspaceName: "Alpha",
                role: "admin",
              },
            ],
          },
        }),
    };

    const app = createApp({
      clock: { now: () => new Date("2026-11-27T09:00:00.000Z") },
      dbHealth: { driver: "sqlite", ping: async () => ({ ok: true }) },
      auth: mockAuth,
      uow: mockUow,
      idGenerator: { next: () => usr1 as never },
    });

    const unauthRes = await app.request("/api/v1/me");
    expect(unauthRes.status).toBe(401);

    const meRes = await app.request("/api/v1/me", {
      headers: { authorization: "Bearer valid" },
    });
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toEqual({
      contractVersion: CONTRACT_VERSION,
      user: { id: usr1, email: "alice@example.com", displayName: "Alice" },
      memberships: [
        {
          membershipId: mbr1,
          workspaceId: wksA,
          workspaceSlug: "alpha",
          workspaceName: "Alpha",
          role: "admin",
        },
      ],
    });

    const allowedWsRes = await app.request(`/api/v1/workspaces/${wksA}/membership`, {
      headers: { authorization: "Bearer valid" },
    });
    expect(allowedWsRes.status).toBe(200);

    const forbiddenWsRes = await app.request(`/api/v1/workspaces/${wksB}/membership`, {
      headers: { authorization: "Bearer valid" },
    });
    expect(forbiddenWsRes.status).toBe(403);
    expect(meRes.headers.get("cache-control")).toBe("no-store");
  });

  it("returns structured JSON 500 via app.onError and enforces server startup config & web security headers", async () => {
    const failingApp = createApp({
      clock: { now: () => new Date("2026-11-27T09:00:00.000Z") },
      dbHealth: {
        driver: "sqlite",
        ping: async () => {
          throw new Error("DB unreachable");
        },
      },
    });
    const errRes = await failingApp.request("/api/v1/health");
    expect(errRes.status).toBe(500);
    expect(await errRes.json()).toEqual({
      contractVersion: CONTRACT_VERSION,
      error: { code: "INTERNAL_ERROR", messageKey: "error.generic" },
    });

    // Server config guards
    expect(() =>
      resolveServerConfig({ NODE_ENV: "production" }),
    ).toThrow(/PROOD_AUTH_SECRET/);
    expect(() =>
      resolveServerConfig({ NODE_ENV: "production", PROOD_AUTH_SECRET: "short" }),
    ).toThrow(/32 characters/);
    expect(() =>
      resolveServerConfig({ PORT: "not-a-port" }),
    ).toThrow(/Invalid PORT/);
    expect(resolveServerConfig({})).toMatchObject({
      port: 3000,
      hostname: "127.0.0.1",
      baseURL: "http://127.0.0.1:3000",
    });

    // Static web asset security headers on /, /oauth/consent, /oauth/consent/
    const assetDir = mkdtempSync(join(tmpdir(), "prood-web-assets-"));
    try {
      writeFileSync(join(assetDir, "index.html"), "<html></html>");
      writeFileSync(join(assetDir, "shell.js"), "console.log(1);");
      writeFileSync(join(assetDir, "shell.css"), "body{}");

      const rootApp = createApp({
        clock: { now: () => new Date("2026-11-27T09:00:00.000Z") },
        dbHealth: { driver: "sqlite", ping: async () => ({ ok: true }) },
      });
      mountWebShellAssets(rootApp, assetDir);

      for (const route of ["/", "/oauth/consent", "/oauth/consent/"]) {
        const res = await rootApp.request(route);
        expect(res.status).toBe(200);
        expect(res.headers.get("x-frame-options")).toBe("DENY");
        expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
        expect(res.headers.get("referrer-policy")).toBe("no-referrer");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      }
      const jsRes = await rootApp.request("/shell.js");
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      rmSync(assetDir, { recursive: true, force: true });
    }
  });
});
