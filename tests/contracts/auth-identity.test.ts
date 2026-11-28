import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSystemIdGenerator } from "@prood/application";
import type {
  ApiErrorResponse,
  DbDriverKind,
  MeResponse,
  WorkspaceMembershipResponse,
} from "@prood/contracts";
import { isValidEntityId } from "@prood/domain";
import { createBetterAuthAdapter } from "@prood/integration-better-auth";
import type { KyselyBackedDatabaseClient } from "@prood/persistence-common";
import {
  createPostgresDatabase,
  createPostgresSchema,
  dropPostgresSchema,
} from "@prood/persistence-postgres";
import { createSqliteDatabase } from "@prood/persistence-sqlite";
import { createApp } from "@prood/server/app";

const targetDb = process.env.PROOD_TEST_DB as DbDriverKind | undefined;
if (targetDb !== "sqlite" && targetDb !== "postgres") {
  throw new Error(
    `PROOD_TEST_DB must be "sqlite" or "postgres" (received: ${String(targetDb)})`,
  );
}

const BASE_URL = "http://127.0.0.1:3000";
const AUTH_SECRET = "prood-test-secret-key-at-least-32-bytes-long";

interface IsolatedAuthDb {
  openClient(): KyselyBackedDatabaseClient;
  cleanup(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

async function createIsolatedAuthDb(): Promise<IsolatedAuthDb> {
  const opened: KyselyBackedDatabaseClient[] = [];

  if (targetDb === "sqlite") {
    const dir = mkdtempSync(join(tmpdir(), "prood-auth-sqlite-"));
    const filePath = join(dir, "auth.sqlite");
    const ctx: IsolatedAuthDb = {
      openClient() {
        const client = createSqliteDatabase({ filePath });
        opened.push(client);
        return client;
      },
      async cleanup() {
        for (const client of opened.splice(0)) {
          await client.close();
        }
        rmSync(dir, { recursive: true, force: true });
      },
    };
    cleanups.push(() => ctx.cleanup());
    return ctx;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set when PROOD_TEST_DB=postgres");
  }

  const schema = `prood_auth_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await createPostgresSchema(connectionString, schema);

  const ctx: IsolatedAuthDb = {
    openClient() {
      const client = createPostgresDatabase({ connectionString, schema });
      opened.push(client);
      return client;
    },
    async cleanup() {
      for (const client of opened.splice(0)) {
        await client.close();
      }
      await dropPostgresSchema(connectionString, schema);
    },
  };
  cleanups.push(() => ctx.cleanup());
  return ctx;
}

class CookieJar {
  private cookies = new Map<string, string>();

  updateFrom(res: Response): void {
    const setCookies = res.headers.getSetCookie();
    for (const header of setCookies) {
      const firstPart = header.split(";")[0];
      if (!firstPart) {
        continue;
      }
      const eqIdx = firstPart.indexOf("=");
      if (eqIdx <= 0) {
        continue;
      }
      const name = firstPart.slice(0, eqIdx).trim();
      const value = firstPart.slice(eqIdx + 1).trim();
      if (value === "") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  toHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function buildTestServer(db: KyselyBackedDatabaseClient) {
  const auth = createBetterAuthAdapter({
    db,
    secret: AUTH_SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
  });
  const app = createApp({
    clock: { now: () => new Date() },
    dbHealth: db,
    auth,
    uow: db.uow,
    idGenerator: createSystemIdGenerator(),
  });

  async function request(
    path: string,
    init: {
      method?: string;
      json?: unknown;
      cookieHeader?: string;
    } = {},
  ): Promise<Response> {
    const headers = new Headers();
    headers.set("origin", BASE_URL);
    if (init.cookieHeader) {
      headers.set("cookie", init.cookieHeader);
    }
    let body: string | undefined;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    return app.request(
      new Request(`${BASE_URL}${path}`, {
        method: init.method ?? "GET",
        headers,
        body,
      }),
    );
  }

  return { app, request };
}

describe(`Better Auth, Prood users & workspace memberships (${targetDb})`, () => {
  it("upgrades from v2 with existing workspaces to v3 without losing data", async () => {
    const ctx = await createIsolatedAuthDb();
    const db = ctx.openClient();
    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    const now = "2026-11-27T11:00:00.000Z";

    await db.migrate({ targetVersion: 2 });
    await db.uow.run((repos) =>
      repos.workspaces.create({
        id: wksId,
        slug: "legacy-v2",
        name: "Legacy V2 Workspace",
        createdAt: now,
      }),
    );

    const v3 = await db.migrate();
    expect(v3).toEqual({ appliedVersions: [3, 4, 5, 6, 7], currentVersion: 7 });

    const loaded = await db.uow.run((repos) => repos.workspaces.findById(wksId));
    expect(loaded?.slug).toBe("legacy-v2");
  });

  it("signs up, logs in, resolves the same Prood user across re-login, and signs out", async () => {
    const ctx = await createIsolatedAuthDb();
    const db = ctx.openClient();
    await db.migrate();
    const { request } = buildTestServer(db);

    const jar1 = new CookieJar();
    const signUpRes = await request("/api/auth/sign-up/email", {
      method: "POST",
      json: {
        email: "Alice@Example.com",
        password: "correct-horse-battery-staple",
        name: "Alice",
      },
    });
    expect(signUpRes.status).toBe(200);
    jar1.updateFrom(signUpRes);
    expect(jar1.toHeader()).not.toBe("");

    const meRes1 = await request("/api/v1/me", {
      cookieHeader: jar1.toHeader(),
    });
    expect(meRes1.status).toBe(200);
    const profile1 = (await meRes1.json()) as MeResponse;
    expect(isValidEntityId("usr", profile1.user.id)).toBe(true);
    expect(profile1.user.email).toBe("alice@example.com");
    expect(profile1.user.displayName).toBe("Alice");
    expect(profile1.memberships).toEqual([]);

    const signOutRes = await request("/api/auth/sign-out", {
      method: "POST",
      cookieHeader: jar1.toHeader(),
    });
    expect(signOutRes.status).toBe(200);

    // Re-login with email + password in a fresh cookie jar
    const jar2 = new CookieJar();
    const signInRes = await request("/api/auth/sign-in/email", {
      method: "POST",
      json: {
        email: "alice@example.com",
        password: "correct-horse-battery-staple",
      },
    });
    expect(signInRes.status).toBe(200);
    jar2.updateFrom(signInRes);

    const meRes2 = await request("/api/v1/me", {
      cookieHeader: jar2.toHeader(),
    });
    expect(meRes2.status).toBe(200);
    const profile2 = (await meRes2.json()) as MeResponse;
    expect(profile2.user.id).toBe(profile1.user.id);
    expect(profile2.user.email).toBe("alice@example.com");
  });

  it("rejects unauthenticated, logged-out, and expired sessions with 401 UNAUTHORIZED", async () => {
    const ctx = await createIsolatedAuthDb();
    const db = ctx.openClient();
    await db.migrate();
    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    await db.uow.run((repos) =>
      repos.workspaces.create({
        id: wksId,
        slug: "sec-ws",
        name: "Security Workspace",
        createdAt: "2026-11-27T11:10:00.000Z",
      }),
    );

    const { request } = buildTestServer(db);

    // 1. Unauthenticated request
    const unauthMe = await request("/api/v1/me");
    expect(unauthMe.status).toBe(401);
    expect(((await unauthMe.json()) as ApiErrorResponse).error.code).toBe(
      "UNAUTHORIZED",
    );

    // 2. Sign up and snapshot session cookie before logout
    const jar = new CookieJar();
    const signUpRes = await request("/api/auth/sign-up/email", {
      method: "POST",
      json: {
        email: "bob@example.com",
        password: "correct-horse-battery-staple",
        name: "Bob",
      },
    });
    expect(signUpRes.status).toBe(200);
    jar.updateFrom(signUpRes);
    const preLogoutCookie = jar.toHeader();

    const signOutRes = await request("/api/auth/sign-out", {
      method: "POST",
      cookieHeader: preLogoutCookie,
    });
    expect(signOutRes.status).toBe(200);

    // Replay old session cookie after logout
    const postLogoutMe = await request("/api/v1/me", {
      cookieHeader: preLogoutCookie,
    });
    expect(postLogoutMe.status).toBe(401);

    const postLogoutWs = await request(`/api/v1/workspaces/${wksId}/membership`, {
      cookieHeader: preLogoutCookie,
    });
    expect(postLogoutWs.status).toBe(401);

    // 3. Sign in again, then expire the session in DB
    const jar2 = new CookieJar();
    const signInRes = await request("/api/auth/sign-in/email", {
      method: "POST",
      json: {
        email: "bob@example.com",
        password: "correct-horse-battery-staple",
      },
    });
    expect(signInRes.status).toBe(200);
    jar2.updateFrom(signInRes);
    const activeCookie = jar2.toHeader();

    expect((await request("/api/v1/me", { cookieHeader: activeCookie })).status).toBe(
      200,
    );

    await db.kysely
      .updateTable("auth_session")
      .set({ expiresAt: new Date("2000-01-01T00:00:00.000Z").toISOString() })
      .execute();

    const expiredMe = await request("/api/v1/me", {
      cookieHeader: activeCookie,
    });
    expect(expiredMe.status).toBe(401);

    const expiredWs = await request(`/api/v1/workspaces/${wksId}/membership`, {
      cookieHeader: activeCookie,
    });
    expect(expiredWs.status).toBe(401);
  });

  it("isolates workspace memberships across workspaces and denies non-member access", async () => {
    const ctx = await createIsolatedAuthDb();
    const db = ctx.openClient();
    await db.migrate();
    const ids = createSystemIdGenerator();
    const wksA = ids.next("wks");
    const wksB = ids.next("wks");
    const missingWks = ids.next("wks");
    const now = "2026-11-27T11:20:00.000Z";

    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksA,
        slug: "workspace-a",
        name: "Workspace A",
        createdAt: now,
      });
      await repos.workspaces.create({
        id: wksB,
        slug: "workspace-b",
        name: "Workspace B",
        createdAt: now,
      });
    });

    const { request } = buildTestServer(db);

    const jarUser1 = new CookieJar();
    const res1 = await request("/api/auth/sign-up/email", {
      method: "POST",
      json: {
        email: "user1@example.com",
        password: "password-one-1234",
        name: "User One",
      },
    });
    expect(res1.status).toBe(200);
    jarUser1.updateFrom(res1);

    const jarUser2 = new CookieJar();
    const res2 = await request("/api/auth/sign-up/email", {
      method: "POST",
      json: {
        email: "user2@example.com",
        password: "password-two-1234",
        name: "User Two",
      },
    });
    expect(res2.status).toBe(200);
    jarUser2.updateFrom(res2);

    const me1Initial = (await (
      await request("/api/v1/me", { cookieHeader: jarUser1.toHeader() })
    ).json()) as MeResponse;
    const me2Initial = (await (
      await request("/api/v1/me", { cookieHeader: jarUser2.toHeader() })
    ).json()) as MeResponse;

    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksA,
        userId: me1Initial.user.id,
        role: "admin",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksB,
        userId: me2Initial.user.id,
        role: "viewer",
        createdAt: now,
      });
    });

    const me1 = (await (
      await request("/api/v1/me", { cookieHeader: jarUser1.toHeader() })
    ).json()) as MeResponse;
    expect(me1.memberships).toHaveLength(1);
    expect(me1.memberships[0]).toMatchObject({
      workspaceId: wksA,
      workspaceSlug: "workspace-a",
      role: "admin",
    });

    const allowedRes = await request(`/api/v1/workspaces/${wksA}/membership`, {
      cookieHeader: jarUser1.toHeader(),
    });
    expect(allowedRes.status).toBe(200);
    expect(
      ((await allowedRes.json()) as WorkspaceMembershipResponse).membership.role,
    ).toBe("admin");

    // User 1 cannot access Workspace B or non-existent workspace
    const crossWsRes = await request(`/api/v1/workspaces/${wksB}/membership`, {
      cookieHeader: jarUser1.toHeader(),
    });
    expect(crossWsRes.status).toBe(403);
    expect(((await crossWsRes.json()) as ApiErrorResponse).error.code).toBe(
      "FORBIDDEN",
    );

    const missingWsRes = await request(
      `/api/v1/workspaces/${missingWks}/membership`,
      { cookieHeader: jarUser1.toHeader() },
    );
    expect(missingWsRes.status).toBe(403);
    expect(((await missingWsRes.json()) as ApiErrorResponse).error.code).toBe(
      "FORBIDDEN",
    );
  });

  it("blocks unverified email sign-up from hijacking pre-existing users and handles concurrent first-login resolution", async () => {
    const ctx = await createIsolatedAuthDb();
    const db = ctx.openClient();
    await db.migrate();
    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    const preUserId = ids.next("usr");
    const mbrId = ids.next("mbr");
    const now = "2026-11-27T11:30:00.000Z";

    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "invited-ws",
        name: "Invited Workspace",
        createdAt: now,
      });
      await repos.users.create({
        id: preUserId,
        email: "victim@example.com",
        displayName: "Invited Admin",
        createdAt: now,
      });
      await repos.memberships.create({
        id: mbrId,
        workspaceId: wksId,
        userId: preUserId,
        role: "admin",
        createdAt: now,
      });
    });

    const { request } = buildTestServer(db);

    // 1. Unverified attacker signs up with victim@example.com -> /api/v1/me MUST return 403 and must not link
    const attackerJar = new CookieJar();
    const attackerSignUp = await request("/api/auth/sign-up/email", {
      method: "POST",
      json: {
        email: "victim@example.com",
        password: "attacker-password-123",
        name: "Attacker",
      },
    });
    expect(attackerSignUp.status).toBe(200);
    attackerJar.updateFrom(attackerSignUp);

    const hijackMe = await request("/api/v1/me", {
      cookieHeader: attackerJar.toHeader(),
    });
    expect(hijackMe.status).toBe(403);
    expect(((await hijackMe.json()) as ApiErrorResponse).error.messageKey).toBe(
      "error.emailVerificationRequired",
    );

    const hijackWs = await request(`/api/v1/workspaces/${wksId}/membership`, {
      cookieHeader: attackerJar.toHeader(),
    });
    expect(hijackWs.status).toBe(403);

    // 2. Fresh verified user hitting /api/v1/me concurrently creates exactly one Prood user
    const concurrentJar = new CookieJar();
    const freshSignUp = await request("/api/auth/sign-up/email", {
      method: "POST",
      json: {
        email: "concurrent@example.com",
        password: "concurrent-password-123",
        name: "Concurrent",
      },
    });
    expect(freshSignUp.status).toBe(200);
    concurrentJar.updateFrom(freshSignUp);

    const [resA, resB, resC] = await Promise.all([
      request("/api/v1/me", { cookieHeader: concurrentJar.toHeader() }),
      request("/api/v1/me", { cookieHeader: concurrentJar.toHeader() }),
      request("/api/v1/me", { cookieHeader: concurrentJar.toHeader() }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resC.status).toBe(200);
    const profiles = (await Promise.all([
      resA.json(),
      resB.json(),
      resC.json(),
    ])) as MeResponse[];
    expect(new Set(profiles.map((p) => p.user.id)).size).toBe(1);
  });
});
