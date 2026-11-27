import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSystemIdGenerator,
  createWorkUseCases,
  type UnitOfWork,
} from "@prood/application";
import {
  CONTRACT_VERSION,
  type ApiErrorResponse,
  type DbDriverKind,
  type MeResponse,
  type ProjectResponse,
  type TaskListResponse,
  type TaskResponse,
} from "@prood/contracts";
import {
  isValidEntityId,
  isValidTaskPublicIdFormat,
  OUTBOX_SCHEMA_VERSION,
} from "@prood/domain";
import { createBetterAuthAdapter } from "@prood/integration-better-auth";
import { createProodMcpServer } from "@prood/integration-fastmcp";
import {
  isPersistenceError,
  type KyselyBackedDatabaseClient,
} from "@prood/persistence-common";
import {
  createPostgresDatabase,
  createPostgresSchema,
  dropPostgresSchema,
  mapPostgresError,
} from "@prood/persistence-postgres";
import {
  createSqliteDatabase,
  mapSqliteError,
} from "@prood/persistence-sqlite";
import { createApp } from "@prood/server/app";

const targetDb = process.env.PROOD_TEST_DB as DbDriverKind | undefined;
if (targetDb !== "sqlite" && targetDb !== "postgres") {
  throw new Error(
    `PROOD_TEST_DB must be "sqlite" or "postgres" (received: ${String(targetDb)})`,
  );
}

const BASE_URL = "http://127.0.0.1:3000";
const AUTH_SECRET = "prood-work-outbox-test-secret-at-least-32-chars";

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
    const dir = mkdtempSync(join(tmpdir(), "prood-work-sqlite-"));
    const filePath = join(dir, "work.sqlite");
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

  const schema = `prood_work_${Date.now().toString(36)}_${Math.random()
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

function createServerHarness(db: KyselyBackedDatabaseClient) {
  const clock = { now: () => new Date("2026-11-27T14:00:00.000Z") };
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
  const mcpHandler = createProodMcpServer({
    resource: `${BASE_URL}/mcp`,
    tokenVerifier: auth,
    uow: db.uow,
    idGenerator,
    clock,
    trustedOrigins: [BASE_URL],
    onAuthFailure: (info) =>
      workUseCases.recordEntryAuthFailure({
        channel: "mcp",
        path: info.path,
        reasonCode: info.reasonCode,
        detail: info.detail,
      }),
  });
  const app = createApp({
    clock,
    dbHealth: db,
    auth,
    uow: db.uow,
    idGenerator,
    mcpAuth: auth,
    mcpHandler,
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

  return { app, request, signUpUser, workUseCases };
}

describe(`Work items, authorization & versioned outbox (${targetDb})`, () => {
  it("upgrades from v4 to v5 preserving existing workspaces and users", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    const usrId = ids.next("usr");
    const now = "2026-11-27T13:00:00.000Z";

    await db.migrate({ targetVersion: 4 });
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "v4-ws",
        name: "V4 Workspace",
        createdAt: now,
      });
      await repos.users.create({
        id: usrId,
        email: "v4@example.com",
        displayName: "V4 User",
        createdAt: now,
      });
    });

    const v5 = await db.migrate();
    expect(v5).toEqual({ appliedVersions: [5], currentVersion: 5 });

    const loaded = await db.uow.run(async (repos) => ({
      ws: await repos.workspaces.findById(wksId),
      usr: await repos.users.findById(usrId),
      outbox: await repos.outbox.listAll(),
    }));
    expect(loaded.ws?.slug).toBe("v4-ws");
    expect(loaded.usr?.email).toBe("v4@example.com");
    expect(loaded.outbox).toEqual([]);
  });

  it("enforces mandatory immutable tsk_* public IDs on general & development tasks and rolls back atomically if outbox append fails", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const ids = createSystemIdGenerator();
    const harness = createServerHarness(db);

    const wksId = ids.next("wks");
    const now = "2026-11-27T13:10:00.000Z";
    await db.uow.run((repos) =>
      repos.workspaces.create({
        id: wksId,
        slug: "alpha-ws",
        name: "Alpha Workspace",
        createdAt: now,
      }),
    );

    const admin = await harness.signUpUser("admin-atomic@example.com", "Admin");
    await db.uow.run((repos) =>
      repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: admin.userId,
        role: "admin",
        createdAt: now,
      }),
    );

    // 1. Create general and development projects
    const genProjRes = await harness.request(`/api/v1/workspaces/${wksId}/projects`, {
      method: "POST",
      cookieHeader: admin.jar.toHeader(),
      json: { name: "General Ops", kind: "general", visibility: "workspace" },
    });
    expect(genProjRes.status).toBe(201);
    const genProject = ((await genProjRes.json()) as ProjectResponse).project;

    const devProjRes = await harness.request(`/api/v1/workspaces/${wksId}/projects`, {
      method: "POST",
      cookieHeader: admin.jar.toHeader(),
      json: { name: "Core Dev", kind: "development", visibility: "workspace" },
    });
    expect(devProjRes.status).toBe(201);
    const devProject = ((await devProjRes.json()) as ProjectResponse).project;

    // 2. Tasks in both project kinds carry immutable tsk_* public IDs + committed succeeded outbox events
    const genTaskRes = await harness.request(
      `/api/v1/projects/${genProject.id}/tasks`,
      {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "General Task 1" },
      },
    );
    expect(genTaskRes.status).toBe(201);
    const genTask = ((await genTaskRes.json()) as TaskResponse).task;
    expect(isValidTaskPublicIdFormat(genTask.id)).toBe(true);

    const devTaskRes = await harness.request(
      `/api/v1/projects/${devProject.id}/tasks`,
      {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "Dev Task 1" },
      },
    );
    expect(devTaskRes.status).toBe(201);
    const devTask = ((await devTaskRes.json()) as TaskResponse).task;
    expect(isValidTaskPublicIdFormat(devTask.id)).toBe(true);

    // 3. Reject attempting to mutate public ID via PATCH
    const mutateIdRes = await harness.request(`/api/v1/tasks/${genTask.id}`, {
      method: "PATCH",
      cookieHeader: admin.jar.toHeader(),
      json: { id: ids.next("tsk"), title: "Mutated" },
    });
    expect(mutateIdRes.status).toBe(400);

    // 4. DB constraints reject NULL id and duplicate id on tasks
    let nullTaskErr: unknown;
    try {
      await db.kysely
        .insertInto("tasks")
        .values({
          id: null as unknown as string,
          workspace_id: wksId,
          project_id: genProject.id,
          parent_task_id: null,
          status_id: null,
          title: "Null ID",
          description: "",
          assignee_id: null,
          created_by: admin.userId,
          due_on: null,
          completed_at: null,
          position: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();
    } catch (error) {
      nullTaskErr = error;
    }
    try {
      if (targetDb === "sqlite") {
        mapSqliteError(nullTaskErr);
      } else {
        mapPostgresError(nullTaskErr);
      }
    } catch (mapped) {
      expect(isPersistenceError(mapped, "NOT_NULL_VIOLATION")).toBe(true);
    }

    let dupTaskErr: unknown;
    try {
      await db.kysely
        .insertInto("tasks")
        .values({
          id: genTask.id,
          workspace_id: wksId,
          project_id: genProject.id,
          parent_task_id: null,
          status_id: null,
          title: "Dup ID",
          description: "",
          assignee_id: null,
          created_by: admin.userId,
          due_on: null,
          completed_at: null,
          position: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();
    } catch (error) {
      dupTaskErr = error;
    }
    try {
      if (targetDb === "sqlite") {
        mapSqliteError(dupTaskErr);
      } else {
        mapPostgresError(dupTaskErr);
      }
    } catch (mapped) {
      expect(isPersistenceError(mapped, "UNIQUE_VIOLATION")).toBe(true);
    }

    // 5. Outbox failure rolls back both createTask and updateTask atomically
    const faultInjectingUow: UnitOfWork = {
      run: (fn) =>
        db.uow.run((repos) =>
          fn({
            ...repos,
            outbox: {
              ...repos.outbox,
              append: async () => {
                throw new Error("Simulated outbox write failure");
              },
            },
          }),
        ),
    };
    const faultyWork = createWorkUseCases({
      uow: faultInjectingUow,
      idGenerator: ids,
      clock: { now: () => new Date(now) },
    });
    const actor = {
      userId: admin.userId,
      actorType: "user" as const,
      channel: "web" as const,
    };

    await expect(
      faultyWork.createTask(actor, genProject.id, { title: "Should Rollback" }),
    ).rejects.toThrow("Simulated outbox write failure");

    const tasksAfterFailedCreate = await db.uow.run((repos) =>
      repos.tasks.listByProject(genProject.id),
    );
    expect(tasksAfterFailedCreate).toHaveLength(1);
    expect(tasksAfterFailedCreate[0]?.id).toBe(genTask.id);

    await expect(
      faultyWork.updateTask(actor, genTask.id, { title: "Rollback Update" }),
    ).rejects.toThrow("Simulated outbox write failure");

    const unchangedTask = await db.uow.run((repos) =>
      repos.tasks.findById(genTask.id),
    );
    expect(unchangedTask?.title).toBe("General Task 1");

    const events = await db.uow.run((repos) =>
      repos.outbox.listByWorkspace(wksId),
    );
    expect(events.map((e) => `${e.eventType}:${e.outcome}:${e.schemaVersion}`)).toEqual([
      `project.created:succeeded:${OUTBOX_SCHEMA_VERSION}`,
      `project.created:succeeded:${OUTBOX_SCHEMA_VERSION}`,
      `task.created:succeeded:${OUTBOX_SCHEMA_VERSION}`,
      `task.created:succeeded:${OUTBOX_SCHEMA_VERSION}`,
    ]);
  });

  it("enforces viewer denial, private-project isolation, inherited subtask visibility, and entry auth-failure events", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const ids = createSystemIdGenerator();
    const harness = createServerHarness(db);

    const wksA = ids.next("wks");
    const wksB = ids.next("wks");
    const now = "2026-11-27T13:20:00.000Z";
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksA,
        slug: "ws-one",
        name: "Workspace One",
        createdAt: now,
      });
      await repos.workspaces.create({
        id: wksB,
        slug: "ws-two",
        name: "Workspace Two",
        createdAt: now,
      });
    });

    const admin = await harness.signUpUser("admin@example.com", "Admin");
    const assignee = await harness.signUpUser("assignee@example.com", "Assignee");
    const otherMember = await harness.signUpUser("other@example.com", "Other Member");
    const viewer = await harness.signUpUser("viewer@example.com", "Viewer");

    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksA,
        userId: admin.userId,
        role: "admin",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksA,
        userId: assignee.userId,
        role: "member",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksA,
        userId: otherMember.userId,
        role: "member",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksA,
        userId: viewer.userId,
        role: "viewer",
        createdAt: now,
      });
      // otherMember also belongs to wksB, admin does not belong to wksB
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksB,
        userId: otherMember.userId,
        role: "admin",
        createdAt: now,
      });
    });

    // Open workspace project + Private project (only admin + assignee have access; otherMember has workspace membership only)
    const openProjRes = await harness.request(`/api/v1/workspaces/${wksA}/projects`, {
      method: "POST",
      cookieHeader: admin.jar.toHeader(),
      json: { name: "Public Board", kind: "general", visibility: "workspace" },
    });
    const openProj = ((await openProjRes.json()) as ProjectResponse).project;

    const privProjRes = await harness.request(`/api/v1/workspaces/${wksA}/projects`, {
      method: "POST",
      cookieHeader: admin.jar.toHeader(),
      json: { name: "Secret Security", kind: "development", visibility: "private" },
    });
    const privProj = ((await privProjRes.json()) as ProjectResponse).project;

    await db.uow.run((repos) =>
      repos.projects.upsertMembership({
        id: ids.next("mbr"),
        projectId: privProj.id,
        userId: assignee.userId,
        role: "member",
        createdAt: now,
      }),
    );

    // Parent task + 2-level inherited subtasks inside Private project
    const parentRes = await harness.request(`/api/v1/projects/${privProj.id}/tasks`, {
      method: "POST",
      cookieHeader: assignee.jar.toHeader(),
      json: {
        title: "Secret Parent",
        assigneeId: assignee.userId,
      },
    });
    expect(parentRes.status).toBe(201);
    const parentTask = ((await parentRes.json()) as TaskResponse).task;

    const childRes = await harness.request(`/api/v1/projects/${privProj.id}/tasks`, {
      method: "POST",
      cookieHeader: assignee.jar.toHeader(),
      json: {
        title: "Inherited Child Subtask",
        parentTaskId: parentTask.id,
      },
    });
    expect(childRes.status).toBe(201);
    const childTask = ((await childRes.json()) as TaskResponse).task;
    expect(childTask.projectId).toBeNull();
    expect(childTask.effectiveProjectId).toBe(privProj.id);

    const grandChildRes = await harness.request(
      `/api/v1/projects/${privProj.id}/tasks`,
      {
        method: "POST",
        cookieHeader: assignee.jar.toHeader(),
        json: {
          title: "Inherited Grandchild Subtask",
          parentTaskId: childTask.id,
        },
      },
    );
    expect(grandChildRes.status).toBe(201);
    const grandChildTask = ((await grandChildRes.json()) as TaskResponse).task;
    expect(grandChildTask.projectId).toBeNull();
    expect(grandChildTask.effectiveProjectId).toBe(privProj.id);

    // Task in open project
    const openTaskRes = await harness.request(`/api/v1/projects/${openProj.id}/tasks`, {
      method: "POST",
      cookieHeader: admin.jar.toHeader(),
      json: { title: "Open Task" },
    });
    expect(openTaskRes.status).toBe(201);
    const openTask = ((await openTaskRes.json()) as TaskResponse).task;

    // 1. Authorized member reads parent, child, grandchild; project list includes inherited subtasks
    const readGrandchildRes = await harness.request(`/api/v1/tasks/${grandChildTask.id}`, {
      cookieHeader: assignee.jar.toHeader(),
    });
    expect(readGrandchildRes.status).toBe(200);
    expect(((await readGrandchildRes.json()) as TaskResponse).task.effectiveProjectId).toBe(
      privProj.id,
    );

    const privListRes = await harness.request(`/api/v1/projects/${privProj.id}/tasks`, {
      cookieHeader: assignee.jar.toHeader(),
    });
    expect(privListRes.status).toBe(200);
    const privList = ((await privListRes.json()) as TaskListResponse).tasks;
    expect(privList.map((t) => t.id)).toEqual([
      parentTask.id,
      childTask.id,
      grandChildTask.id,
    ]);

    // 2. Non-member of private project gets 404 on child/grandchild subtask & 403 on write
    const nonMemberReadSubtask = await harness.request(`/api/v1/tasks/${childTask.id}`, {
      cookieHeader: otherMember.jar.toHeader(),
    });
    expect(nonMemberReadSubtask.status).toBe(404);

    // 3. Viewer can read open project task, is denied writing on open project with 403
    const viewerReadOpen = await harness.request(`/api/v1/tasks/${openTask.id}`, {
      cookieHeader: viewer.jar.toHeader(),
    });
    expect(viewerReadOpen.status).toBe(200);

    const viewerCreateOpen = await harness.request(
      `/api/v1/projects/${openProj.id}/tasks`,
      {
        method: "POST",
        cookieHeader: viewer.jar.toHeader(),
        json: { title: "Viewer Forbidden" },
      },
    );
    expect(viewerCreateOpen.status).toBe(403);
    expect(((await viewerCreateOpen.json()) as ApiErrorResponse).error.code).toBe(
      "FORBIDDEN",
    );

    const viewerUpdateOpen = await harness.request(`/api/v1/tasks/${openTask.id}`, {
      method: "PATCH",
      cookieHeader: viewer.jar.toHeader(),
      json: { title: "Viewer Mutated" },
    });
    expect(viewerUpdateOpen.status).toBe(403);

    const unchangedOpen = await db.uow.run((repos) => repos.tasks.findById(openTask.id));
    expect(unchangedOpen?.title).toBe("Open Task");

    // 4. Cross-workspace user cannot access wksB project
    const wksBProjRes = await harness.request(`/api/v1/workspaces/${wksB}/projects`, {
      method: "POST",
      cookieHeader: otherMember.jar.toHeader(),
      json: { name: "WS B Project", kind: "general", visibility: "workspace" },
    });
    const wksBProj = ((await wksBProjRes.json()) as ProjectResponse).project;
    const crossWsRead = await harness.request(`/api/v1/projects/${wksBProj.id}/tasks`, {
      cookieHeader: admin.jar.toHeader(),
    });
    expect(crossWsRead.status).toBe(404);

    // 5. Entry-level auth failures on Web and MCP record outbox events
    const unauthWebRes = await harness.request(`/api/v1/projects/${openProj.id}/tasks`);
    expect(unauthWebRes.status).toBe(401);

    const badLoginRes = await harness.request("/api/auth/sign-in/email", {
      method: "POST",
      json: { email: "admin@example.com", password: "wrong-password" },
    });
    expect(badLoginRes.status).toBe(401);

    const unauthMcpRes = await harness.request("/mcp", {
      method: "POST",
      json: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    expect(unauthMcpRes.status).toBe(401);

    // Verify succeeded vs denied & entry-level auth failure events in outbox
    const allOutbox = await db.uow.run((repos) => repos.outbox.listAll());
    for (const evt of allOutbox) {
      expect(isValidEntityId("out", evt.id)).toBe(true);
      expect(isValidEntityId("evt", evt.eventId)).toBe(true);
      expect(evt.schemaVersion).toBe(OUTBOX_SCHEMA_VERSION);
    }

    const deniedEvents = allOutbox.filter((e) => e.outcome === "denied");
    const succeededEvents = allOutbox.filter((e) => e.outcome === "succeeded");

    expect(succeededEvents.some((e) => e.eventType === "task.created")).toBe(true);
    expect(
      deniedEvents.some(
        (e) =>
          e.eventType === "task.create.denied" &&
          e.actorUserId === viewer.userId &&
          e.reasonCode === "FORBIDDEN",
      ),
    ).toBe(true);
    expect(
      deniedEvents.some(
        (e) =>
          e.eventType === "task.update.denied" &&
          e.actorUserId === viewer.userId &&
          e.reasonCode === "FORBIDDEN",
      ),
    ).toBe(true);
    expect(
      deniedEvents.some(
        (e) =>
          e.eventType === "task.read.denied" &&
          e.actorUserId === otherMember.userId &&
          e.targetId === childTask.id,
      ),
    ).toBe(true);
    expect(
      deniedEvents.some(
        (e) =>
          e.eventType === "auth.failed" &&
          e.channel === "web" &&
          e.actorType === "anonymous" &&
          e.reasonCode === "UNAUTHORIZED",
      ),
    ).toBe(true);
    expect(
      deniedEvents.some(
        (e) =>
          e.eventType === "auth.failed" &&
          e.channel === "web" &&
          e.actorType === "anonymous" &&
          e.reasonCode === "AUTH_SIGN_IN_FAILED",
      ),
    ).toBe(true);
    expect(
      deniedEvents.some(
        (e) =>
          e.eventType === "auth.failed" &&
          e.channel === "mcp" &&
          e.actorType === "anonymous",
      ),
    ).toBe(true);
  });

  it("enforces subtask depth limit, validates runtime patch types, records description updates, and handles unverified email across work routes", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const ids = createSystemIdGenerator();
    const harness = createServerHarness(db);

    const wksId = ids.next("wks");
    const preUserId = ids.next("usr");
    const now = "2026-11-27T13:30:00.000Z";
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "hardening-ws",
        name: "Hardening Workspace",
        createdAt: now,
      });
      await repos.users.create({
        id: preUserId,
        email: "pre-existing@example.com",
        displayName: "Pre Existing",
        createdAt: now,
      });
    });

    const owner = await harness.signUpUser("owner-depth@example.com", "Owner");
    await db.uow.run((repos) =>
      repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: owner.userId,
        role: "admin",
        createdAt: now,
      }),
    );

    const projRes = await harness.request(`/api/v1/workspaces/${wksId}/projects`, {
      method: "POST",
      cookieHeader: owner.jar.toHeader(),
      json: { name: "Depth Test Project", kind: "general", visibility: "workspace" },
    });
    expect(projRes.status).toBe(201);
    const project = ((await projRes.json()) as ProjectResponse).project;

    // 1. Subtask depth limit: root (depth 0) + 15 inherited levels (depth 1..15) succeed and remain readable
    let parentId: string | undefined;
    for (let level = 0; level < 16; level += 1) {
      const res = await harness.request(`/api/v1/projects/${project.id}/tasks`, {
        method: "POST",
        cookieHeader: owner.jar.toHeader(),
        json: {
          title: `Level ${level}`,
          ...(parentId ? { parentTaskId: parentId } : {}),
        },
      });
      expect(res.status).toBe(201);
      parentId = ((await res.json()) as TaskResponse).task.id;
    }
    expect((await harness.request(`/api/v1/tasks/${parentId}`, { cookieHeader: owner.jar.toHeader() })).status).toBe(200);

    // Level 16 (depth 16, exceeding MAX_PARENT_HOPS=16) must be rejected with 400
    const tooDeepRes = await harness.request(`/api/v1/projects/${project.id}/tasks`, {
      method: "POST",
      cookieHeader: owner.jar.toHeader(),
      json: { title: "Level 16 too deep", parentTaskId: parentId },
    });
    expect(tooDeepRes.status).toBe(400);
    expect(((await tooDeepRes.json()) as ApiErrorResponse).error.code).toBe("VALIDATION_ERROR");

    // 2. Runtime JSON / patch type validation -> 400 VALIDATION_ERROR (never 500)
    const rootList = ((await (
      await harness.request(`/api/v1/projects/${project.id}/tasks`, {
        cookieHeader: owner.jar.toHeader(),
      })
    ).json()) as TaskListResponse).tasks;
    const targetTaskId = rootList[0]!.id;

    for (const invalidPatch of [
      { title: 123 },
      { title: null },
      { description: 42 },
      "primitive-body",
    ]) {
      const badPatchRes = await harness.request(`/api/v1/tasks/${targetTaskId}`, {
        method: "PATCH",
        cookieHeader: owner.jar.toHeader(),
        json: invalidPatch,
      });
      expect(badPatchRes.status).toBe(400);
      expect(((await badPatchRes.json()) as ApiErrorResponse).error.code).toBe(
        "VALIDATION_ERROR",
      );
    }

    // 3. Description-only PATCH records `description` inside `task.updated` outbox `changes`
    const descUpdateRes = await harness.request(`/api/v1/tasks/${targetTaskId}`, {
      method: "PATCH",
      cookieHeader: owner.jar.toHeader(),
      json: { description: "Updated audit description" },
    });
    expect(descUpdateRes.status).toBe(200);
    expect(((await descUpdateRes.json()) as TaskResponse).task.description).toBe(
      "Updated audit description",
    );

    const wsOutbox = await db.uow.run((repos) => repos.outbox.listByWorkspace(wksId));
    const latestUpdate = wsOutbox.filter((e) => e.eventType === "task.updated").pop();
    expect(latestUpdate?.payload.changes).toEqual({
      description: "Updated audit description",
    });

    // 4. Unverified sign-up session sharing pre-existing email returns 403 error.emailVerificationRequired across all work routes
    const unverifiedJar = new CookieJar();
    const signupRes = await harness.request("/api/auth/sign-up/email", {
      method: "POST",
      json: {
        email: "pre-existing@example.com",
        password: "hijack-password-123",
        name: "Unverified",
      },
    });
    expect(signupRes.status).toBe(200);
    unverifiedJar.updateFrom(signupRes);

    for (const reqSpec of [
      { path: `/api/v1/workspaces/${wksId}/projects`, method: "GET" as const },
      {
        path: `/api/v1/workspaces/${wksId}/projects`,
        method: "POST" as const,
        json: { name: "Blocked" },
      },
      { path: `/api/v1/projects/${project.id}/tasks`, method: "GET" as const },
      {
        path: `/api/v1/projects/${project.id}/tasks`,
        method: "POST" as const,
        json: { title: "Blocked" },
      },
      { path: `/api/v1/tasks/${targetTaskId}`, method: "GET" as const },
      {
        path: `/api/v1/tasks/${targetTaskId}`,
        method: "PATCH" as const,
        json: { title: "Blocked" },
      },
    ]) {
      const res = await harness.request(reqSpec.path, {
        method: reqSpec.method,
        cookieHeader: unverifiedJar.toHeader(),
        json: reqSpec.json,
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as ApiErrorResponse).error.messageKey).toBe(
        "error.emailVerificationRequired",
      );
    }

    const allEvents = await db.uow.run((repos) => repos.outbox.listAll());
    expect(
      allEvents.filter((e) => e.reasonCode === "EMAIL_VERIFICATION_REQUIRED").length,
    ).toBeGreaterThanOrEqual(6);
  });
});
