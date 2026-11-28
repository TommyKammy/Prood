import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSystemIdGenerator, createWorkUseCases } from "@prood/application";
import {
  CONTRACT_VERSION,
  type ApiErrorResponse,
  type DbDriverKind,
  type MeResponse,
  type ProjectResponse,
  type TaskResponse,
} from "@prood/contracts";
import type { AuditActorContext } from "@prood/domain";
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
const AUTH_SECRET = "prood-stage1-hardening-test-secret-32-chars!";

interface IsolatedDb {
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

async function createIsolatedDb(): Promise<IsolatedDb> {
  const opened: KyselyBackedDatabaseClient[] = [];

  if (targetDb === "sqlite") {
    const dir = mkdtempSync(join(tmpdir(), "prood-stage1-sqlite-"));
    const filePath = join(dir, "stage1.sqlite");
    const ctx: IsolatedDb = {
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

  const schema = `prood_s1_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await createPostgresSchema(connectionString, schema);

  const ctx: IsolatedDb = {
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
    for (const header of res.headers.getSetCookie()) {
      const firstPart = header.split(";")[0];
      if (!firstPart) continue;
      const eqIdx = firstPart.indexOf("=");
      if (eqIdx <= 0) continue;
      const name = firstPart.slice(0, eqIdx).trim();
      const value = firstPart.slice(eqIdx + 1).trim();
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  toHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function createServerHarness(db: KyselyBackedDatabaseClient) {
  const clock = { now: () => new Date("2026-11-28T10:00:00.000Z") };
  const idGenerator = createSystemIdGenerator();
  const auth = createBetterAuthAdapter({
    db,
    secret: AUTH_SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    mcpResource: `${BASE_URL}/mcp`,
  });
  const workUseCases = createWorkUseCases({
    uow: db.uow,
    idGenerator,
    clock,
  });
  const app = createApp({
    clock,
    dbHealth: db,
    auth,
    uow: db.uow,
    idGenerator,
    trustedOrigins: [BASE_URL],
    realtime: { pollIntervalMs: 25, heartbeatIntervalMs: 5000 },
  });

  async function request(
    path: string,
    init: {
      method?: string;
      json?: unknown;
      cookieHeader?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("origin") && !("headers" in init)) {
      headers.set("origin", BASE_URL);
    }
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
        signal: init.signal,
      }),
    );
  }

  async function signUpUser(email: string, name: string) {
    const jar = new CookieJar();
    const res = await request("/api/auth/sign-up/email", {
      method: "POST",
      json: { email, password: "prood-test-password-123", name },
    });
    expect(res.status).toBe(200);
    jar.updateFrom(res);
    const meRes = await request("/api/v1/me", { cookieHeader: jar.toHeader() });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as MeResponse;
    return { jar, userId: me.user.id, email: me.user.email };
  }

  return { app, request, signUpUser, workUseCases, idGenerator, clock };
}

describe(`Stage 1 review hardening (${targetDb})`, () => {
  it("closes cross-tenant & private-project 404 existence oracles on updateTask/moveTask, copyTask, and createTask", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const { signUpUser, workUseCases, idGenerator, clock } = createServerHarness(db);

    const alice = await signUpUser("alice-oracle@example.com", "Alice");
    const bob = await signUpUser("bob-oracle@example.com", "Bob");

    const wksA = idGenerator.next("wks");
    const wksB = idGenerator.next("wks");
    const nowIso = clock.now().toISOString();

    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksA,
        slug: "oracle-wks-a",
        name: "Oracle A",
        createdAt: nowIso,
      });
      await repos.workspaces.create({
        id: wksB,
        slug: "oracle-wks-b",
        name: "Oracle B",
        createdAt: nowIso,
      });
      await repos.memberships.create({
        id: idGenerator.next("mbr"),
        workspaceId: wksA,
        userId: alice.userId,
        role: "member",
        createdAt: nowIso,
      });
      await repos.memberships.create({
        id: idGenerator.next("mbr"),
        workspaceId: wksA,
        userId: bob.userId,
        role: "admin",
        createdAt: nowIso,
      });
      await repos.memberships.create({
        id: idGenerator.next("mbr"),
        workspaceId: wksB,
        userId: bob.userId,
        role: "admin",
        createdAt: nowIso,
      });
    });

    const aliceActor: AuditActorContext = {
      userId: alice.userId,
      actorType: "user",
      channel: "web",
    };
    const bobActor: AuditActorContext = {
      userId: bob.userId,
      actorType: "user",
      channel: "web",
    };

    const pA1 = await workUseCases.createProject(aliceActor, wksA, {
      name: "Project A1",
      visibility: "workspace",
    });
    const pA2 = await workUseCases.createProject(aliceActor, wksA, {
      name: "Project A2",
      visibility: "workspace",
    });
    const pAPriv = await workUseCases.createProject(bobActor, wksA, {
      name: "Project A Private",
      visibility: "private",
    });
    const pBSecret = await workUseCases.createProject(bobActor, wksB, {
      name: "Secret B",
      visibility: "workspace",
    });
    expect(pA1.ok && pA2.ok && pAPriv.ok && pBSecret.ok).toBe(true);
    if (!pA1.ok || !pA2.ok || !pAPriv.ok || !pBSecret.ok) return;

    const tA1 = await workUseCases.createTask(aliceActor, pA1.data.project.id, {
      title: "Alice Task 1",
    });
    const tA2 = await workUseCases.createTask(aliceActor, pA2.data.project.id, {
      title: "Alice Task 2",
    });
    const tAPriv = await workUseCases.createTask(bobActor, pAPriv.data.project.id, {
      title: "Bob Private A Task",
    });
    const tB = await workUseCases.createTask(bobActor, pBSecret.data.project.id, {
      title: "Bob Workspace B Task",
    });
    expect(tA1.ok && tA2.ok && tAPriv.ok && tB.ok).toBe(true);
    if (!tA1.ok || !tA2.ok || !tAPriv.ok || !tB.ok) return;

    // 1. updateTask / moveTask targeting unreadable cross-workspace or private project -> 404 (not 400!)
    const moveCrossTenant = await workUseCases.moveTask(aliceActor, tA1.data.task.id, {
      projectId: pBSecret.data.project.id,
    });
    expect(moveCrossTenant.ok).toBe(false);
    if (!moveCrossTenant.ok) {
      expect(moveCrossTenant.status).toBe(404);
      expect(moveCrossTenant.code).toBe("NOT_FOUND");
    }

    const movePrivate = await workUseCases.updateTask(aliceActor, tA1.data.task.id, {
      projectId: pAPriv.data.project.id,
    });
    expect(movePrivate.ok).toBe(false);
    if (!movePrivate.ok) {
      expect(movePrivate.status).toBe(404);
      expect(movePrivate.code).toBe("NOT_FOUND");
    }

    // 2. copyTask targeting unreadable cross-workspace project -> 404 (not 400!)
    const copyCrossTenant = await workUseCases.copyTask(aliceActor, tA1.data.task.id, {
      projectId: pBSecret.data.project.id,
    });
    expect(copyCrossTenant.ok).toBe(false);
    if (!copyCrossTenant.ok) {
      expect(copyCrossTenant.status).toBe(404);
      expect(copyCrossTenant.code).toBe("NOT_FOUND");
    }

    // 3. createTask & copyTask passing unreadable parentTaskId (other workspace or private project) -> 404
    for (const hiddenParentId of [tB.data.task.id, tAPriv.data.task.id]) {
      const createWithHiddenParent = await workUseCases.createTask(
        aliceActor,
        pA1.data.project.id,
        {
          parentTaskId: hiddenParentId,
          title: "Probe Parent",
          idempotencyKey: `probe-${hiddenParentId}`,
        },
      );
      expect(createWithHiddenParent.ok).toBe(false);
      if (!createWithHiddenParent.ok) {
        expect(createWithHiddenParent.status).toBe(404);
        expect(createWithHiddenParent.code).toBe("NOT_FOUND");
      }

      const copyWithHiddenParent = await workUseCases.copyTask(aliceActor, tA1.data.task.id, {
        projectId: pA1.data.project.id,
        parentTaskId: hiddenParentId,
      });
      expect(copyWithHiddenParent.ok).toBe(false);
      if (!copyWithHiddenParent.ok) {
        expect(copyWithHiddenParent.status).toBe(404);
        expect(copyWithHiddenParent.code).toBe("NOT_FOUND");
      }
    }

    // Verify no idempotency record was persisted for rejected hidden parent probe
    const replayProbe = await db.uow.run((repos) =>
      repos.idempotency.findByKey(alice.userId, "task.create", `probe-${tB.data.task.id}`),
    );
    expect(replayProbe).toBeNull();

    // Verify outbox recorded denied events for hidden probes
    const wksBOutbox = await db.uow.run((repos) => repos.outbox.listByWorkspace(wksB));
    expect(wksBOutbox.some((e) => e.eventType === "task.move.denied")).toBe(true);
    expect(wksBOutbox.some((e) => e.eventType === "task.copy.denied")).toBe(true);
    expect(wksBOutbox.some((e) => e.eventType === "task.read.denied")).toBe(true);

    // 4. Contrast: when target IS readable, cross-workspace / cross-project validation still returns 400
    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: idGenerator.next("mbr"),
        workspaceId: wksB,
        userId: alice.userId,
        role: "member",
        createdAt: nowIso,
      });
    });

    const readableCrossWsMove = await workUseCases.moveTask(aliceActor, tA1.data.task.id, {
      projectId: pBSecret.data.project.id,
    });
    expect(readableCrossWsMove.ok).toBe(false);
    if (!readableCrossWsMove.ok) {
      expect(readableCrossWsMove.status).toBe(400);
      expect(readableCrossWsMove.code).toBe("VALIDATION_ERROR");
    }

    const readableCrossWsCopy = await workUseCases.copyTask(aliceActor, tA1.data.task.id, {
      projectId: pBSecret.data.project.id,
    });
    expect(readableCrossWsCopy.ok).toBe(false);
    if (!readableCrossWsCopy.ok) {
      expect(readableCrossWsCopy.status).toBe(400);
      expect(readableCrossWsCopy.code).toBe("VALIDATION_ERROR");
    }

    const readableCrossProjectCreate = await workUseCases.createTask(
      aliceActor,
      pA1.data.project.id,
      {
        parentTaskId: tA2.data.task.id,
        title: "Cross Project Parent",
      },
    );
    expect(readableCrossProjectCreate.ok).toBe(false);
    if (!readableCrossProjectCreate.ok) {
      expect(readableCrossProjectCreate.status).toBe(400);
      expect(readableCrossProjectCreate.code).toBe("VALIDATION_ERROR");
    }
  });

  it("serializes deleteTask with enableDevProject cleanly without FK violations", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const { signUpUser, workUseCases, idGenerator, clock } = createServerHarness(db);

    const alice = await signUpUser("alice-lock@example.com", "Alice Lock");
    const actor: AuditActorContext = {
      userId: alice.userId,
      actorType: "user",
      channel: "web",
    };

    for (let iter = 0; iter < 8; iter += 1) {
      const wksId = idGenerator.next("wks");
      const nowIso = clock.now().toISOString();
      await db.uow.run(async (repos) => {
        await repos.workspaces.create({
          id: wksId,
          slug: `lock-ws-${iter}`,
          name: `Lock WS ${iter}`,
          createdAt: nowIso,
        });
        await repos.memberships.create({
          id: idGenerator.next("mbr"),
          workspaceId: wksId,
          userId: alice.userId,
          role: "admin",
          createdAt: nowIso,
        });
        await repos.workspaceSettings.upsert({
          workspaceId: wksId,
          defaultLocale: "en",
          devProjectsEnabled: true,
          updatedAt: nowIso,
        });
      });

      const projRes = await workUseCases.createProject(actor, wksId, {
        name: `Lock Project ${iter}`,
        kind: "general",
        visibility: "workspace",
      });
      expect(projRes.ok).toBe(true);
      if (!projRes.ok) return;
      const projectId = projRes.data.project.id;

      const t1 = await workUseCases.createTask(actor, projectId, { title: `Keep 1 ${iter}` });
      const t2 = await workUseCases.createTask(actor, projectId, { title: `Delete 2 ${iter}` });
      const t3 = await workUseCases.createTask(actor, projectId, { title: `Keep 3 ${iter}` });
      expect(t1.ok && t2.ok && t3.ok).toBe(true);
      if (!t1.ok || !t2.ok || !t3.ok) return;

      const [enableSettled, deleteSettled] = await Promise.allSettled([
        workUseCases.enableDevProject(actor, projectId, { prefix: "DEV" }),
        workUseCases.deleteTask(actor, t2.data.task.id),
      ]);

      expect(enableSettled.status).toBe("fulfilled");
      expect(deleteSettled.status).toBe("fulfilled");
      if (enableSettled.status === "fulfilled") {
        expect(enableSettled.value.ok).toBe(true);
      }
      if (deleteSettled.status === "fulfilled") {
        expect(deleteSettled.value.ok).toBe(true);
      }

      // Consistent final state: t2 removed with no key; t1 and t3 keyed under DEV
      const [key1, key2, key3, task2] = await db.uow.run(async (repos) =>
        Promise.all([
          repos.issueKeys.findByTaskId(t1.data.task.id),
          repos.issueKeys.findByTaskId(t2.data.task.id),
          repos.issueKeys.findByTaskId(t3.data.task.id),
          repos.tasks.findById(t2.data.task.id),
        ]),
      );
      expect(task2).toBeNull();
      expect(key2).toBeNull();
      expect(key1?.currentPrefix).toBe("DEV");
      expect(key3?.currentPrefix).toBe("DEV");
    }
  });

  it("hardens HTTP API: empty-body POST copy, empty Last-Event-ID cursor fallback, and Origin CSRF checks", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const { request, signUpUser, idGenerator, clock } = createServerHarness(db);

    const alice = await signUpUser("alice-http@example.com", "Alice HTTP");
    const wksId = idGenerator.next("wks");
    const nowIso = clock.now().toISOString();
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "http-hardening",
        name: "HTTP Hardening",
        createdAt: nowIso,
      });
      await repos.memberships.create({
        id: idGenerator.next("mbr"),
        workspaceId: wksId,
        userId: alice.userId,
        role: "admin",
        createdAt: nowIso,
      });
    });

    // 1. Mutating /api/v1/* rejects untrusted or malformed Origin when trustedOrigins is configured
    const evilOriginRes = await request(`/api/v1/workspaces/${wksId}/projects`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      cookieHeader: alice.jar.toHeader(),
      json: { name: "Blocked Project" },
    });
    expect(evilOriginRes.status).toBe(403);
    const evilBody = (await evilOriginRes.json()) as ApiErrorResponse;
    expect(evilBody.error).toEqual({
      code: "FORBIDDEN",
      messageKey: "error.forbidden",
    });

    const malformedOriginRes = await request(`/api/v1/workspaces/${wksId}/projects`, {
      method: "POST",
      headers: { origin: "not-a-valid-url" },
      cookieHeader: alice.jar.toHeader(),
      json: { name: "Blocked Project 2" },
    });
    expect(malformedOriginRes.status).toBe(403);

    const authFailureOutbox = await db.uow.run((repos) => repos.outbox.listAll());
    expect(
      authFailureOutbox.filter((e) => e.reasonCode === "UNTRUSTED_ORIGIN").length,
    ).toBeGreaterThanOrEqual(2);

    // 2. Trusted Origin succeeds
    const createProjRes = await request(`/api/v1/workspaces/${wksId}/projects`, {
      method: "POST",
      cookieHeader: alice.jar.toHeader(),
      json: { name: "Allowed Project" },
    });
    expect(createProjRes.status).toBe(201);
    const createdProj = (await createProjRes.json()) as ProjectResponse;

    const createTaskRes = await request(
      `/api/v1/projects/${createdProj.project.id}/tasks`,
      {
        method: "POST",
        cookieHeader: alice.jar.toHeader(),
        json: { title: "Copyable Task" },
      },
    );
    expect(createTaskRes.status).toBe(201);
    const createdTask = (await createTaskRes.json()) as TaskResponse;

    // 3. POST /api/v1/tasks/:taskRef/copy accepts empty JSON body
    const emptyBodyCopyRes = await request(
      `/api/v1/tasks/${createdTask.task.id}/copy`,
      {
        method: "POST",
        headers: { origin: BASE_URL },
        cookieHeader: alice.jar.toHeader(),
      },
    );
    expect(emptyBodyCopyRes.status).toBe(201);
    const copiedTask = (await emptyBodyCopyRes.json()) as TaskResponse;
    expect(copiedTask.task.id).not.toBe(createdTask.task.id);
    expect(copiedTask.task.title).toBe("Copyable Task");

    // 4. Empty Last-Event-ID header falls back to ?cursor= on SSE endpoint
    // (before the fix, `""` triggered `event: resync` with `cursor_invalid` instead of honoring `?cursor=`)
    const readFirstSseFrame = async (url: string, headers: Record<string, string>) => {
      const sseAbort = new AbortController();
      const res = await request(url, {
        headers,
        cookieHeader: alice.jar.toHeader(),
        signal: sseAbort.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let sseChunk = "";
      try {
        while (!(/\bdata: /.test(sseChunk) && sseChunk.endsWith("\n\n"))) {
          const next = await reader.read();
          if (next.done) break;
          sseChunk += decoder.decode(next.value, { stream: true });
        }
        return sseChunk;
      } finally {
        sseAbort.abort();
        await reader.cancel().catch(() => {});
      }
    };

    const badCursorFallbackChunk = await readFirstSseFrame(
      `/api/v1/workspaces/${wksId}/events?cursor=invalid-cursor`,
      {
        accept: "text/event-stream",
        "last-event-id": "",
      },
    );
    expect(badCursorFallbackChunk).toContain("event: resync");
    expect(badCursorFallbackChunk).toContain("cursor_invalid");

    const initialChunk = await readFirstSseFrame(
      `/api/v1/workspaces/${wksId}/events`,
      { accept: "text/event-stream" },
    );
    const readyDataLine = initialChunk
      .split("\n")
      .find((line) => line.startsWith("data: "));
    const readyCursor = (JSON.parse(readyDataLine!.slice(6)) as { cursor: string }).cursor;

    const resumedChunk = await readFirstSseFrame(
      `/api/v1/workspaces/${wksId}/events?cursor=${encodeURIComponent(readyCursor)}`,
      {
        accept: "text/event-stream",
        "last-event-id": "   ",
      },
    );
    expect(resumedChunk).toContain("event: ready");
    expect(resumedChunk).not.toContain("event: resync");
    expect(resumedChunk).toContain(readyCursor);
  });
});
