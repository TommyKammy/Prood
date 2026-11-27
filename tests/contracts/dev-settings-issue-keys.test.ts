import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSystemIdGenerator,
  createWorkUseCases,
} from "@prood/application";
import type {
  ApiErrorResponse,
  DbDriverKind,
  EnableDevProjectResponse,
  MeResponse,
  ProjectDevSettingsResponse,
  ProjectListResponse,
  ProjectResponse,
  TaskListResponse,
  TaskResponse,
  WorkspaceSettingsResponse,
} from "@prood/contracts";
import {
  isValidEntityId,
  isValidTaskPublicIdFormat,
} from "@prood/domain";
import { createBetterAuthAdapter } from "@prood/integration-better-auth";
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
const AUTH_SECRET = "prood-dev-keys-test-secret-at-least-32-chars!!";

interface IsolatedDb {
  openClient(opts?: {
    busyTimeoutMs?: number;
    maxRetryAttempts?: number;
    retryBaseDelayMs?: number;
    maxPoolSize?: number;
  }): KyselyBackedDatabaseClient;
  sqliteFilePath?: string;
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
    const dir = mkdtempSync(join(tmpdir(), "prood-devkeys-sqlite-"));
    const filePath = join(dir, "devkeys.sqlite");
    const ctx: IsolatedDb = {
      sqliteFilePath: filePath,
      openClient(opts) {
        const client = createSqliteDatabase({
          filePath,
          ...(opts?.busyTimeoutMs !== undefined
            ? { busyTimeoutMs: opts.busyTimeoutMs }
            : {}),
          ...(opts?.maxRetryAttempts !== undefined
            ? { maxRetryAttempts: opts.maxRetryAttempts }
            : {}),
          ...(opts?.retryBaseDelayMs !== undefined
            ? { retryBaseDelayMs: opts.retryBaseDelayMs }
            : {}),
        });
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

  const schema = `prood_devkeys_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await createPostgresSchema(connectionString, schema);

  const ctx: IsolatedDb = {
    openClient(opts) {
      const client = createPostgresDatabase({
        connectionString,
        schema,
        ...(opts?.maxPoolSize !== undefined
          ? { maxPoolSize: opts.maxPoolSize }
          : {}),
        ...(opts?.maxRetryAttempts !== undefined
          ? { maxRetryAttempts: opts.maxRetryAttempts }
          : {}),
        ...(opts?.retryBaseDelayMs !== undefined
          ? { retryBaseDelayMs: opts.retryBaseDelayMs }
          : {}),
      });
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

function createServerHarness(
  db: KyselyBackedDatabaseClient,
  startTimeIso = "2026-11-28T08:00:00.000Z",
) {
  let tick = Date.parse(startTimeIso);
  const clock = {
    now: () => {
      tick += 1000;
      return new Date(tick);
    },
  };
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
    mcpAuth: auth,
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

function createBarrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) {
      release();
    } else {
      await gate;
    }
  };
}

function extractIssueNumber(issueKey: string | null): number {
  expect(issueKey).toBeTruthy();
  const parts = issueKey!.split("-");
  expect(parts).toHaveLength(2);
  return Number(parts[1]);
}

describe(`Dev settings & issue key issuance (${targetDb})`, () => {
  it("upgrades v5 to v6 preserving existing projects/tasks, backfills keys on activation, and enforces workspace gating & unified creation/copy/delete/rename rules", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    const ids = createSystemIdGenerator();
    const wks1 = ids.next("wks");
    const wks2 = ids.next("wks");
    const now = "2026-11-28T07:50:00.000Z";

    // Upgrade test: seed v5 data before applying v6
    await db.migrate({ targetVersion: 5 });
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wks1,
        slug: "dev-ws-1",
        name: "Dev Workspace 1",
        createdAt: now,
      });
      await repos.workspaces.create({
        id: wks2,
        slug: "dev-ws-2",
        name: "Dev Workspace 2",
        createdAt: now,
      });
    });

    const v6 = await db.migrate();
    expect(v6).toEqual({ appliedVersions: [6], currentVersion: 6 });

    const harness = createServerHarness(db);
    const admin1 = await harness.signUpUser("admin1@example.com", "Admin One");
    const member1 = await harness.signUpUser("member1@example.com", "Member One");
    const admin2 = await harness.signUpUser("admin2@example.com", "Admin Two");

    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wks1,
        userId: admin1.userId,
        role: "admin",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wks1,
        userId: member1.userId,
        role: "member",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wks2,
        userId: admin2.userId,
        role: "admin",
        createdAt: now,
      });
    });

    // 1. Workspace settings permissions
    const memberReadWs = await harness.request(`/api/v1/workspaces/${wks1}/settings`, {
      cookieHeader: member1.jar.toHeader(),
    });
    expect(memberReadWs.status).toBe(200);
    expect(
      ((await memberReadWs.json()) as WorkspaceSettingsResponse).settings
        .devProjectsEnabled,
    ).toBe(false);

    const memberPatchWs = await harness.request(`/api/v1/workspaces/${wks1}/settings`, {
      method: "PATCH",
      cookieHeader: member1.jar.toHeader(),
      json: { devProjectsEnabled: true },
    });
    expect(memberPatchWs.status).toBe(403);

    // 2. Create general projects + existing root/subtask tasks BEFORE enabling dev projects
    const devProjRes = await harness.request(`/api/v1/workspaces/${wks1}/projects`, {
      method: "POST",
      cookieHeader: admin1.jar.toHeader(),
      json: { name: "Platform", kind: "general", visibility: "workspace" },
    });
    expect(devProjRes.status).toBe(201);
    const platformProj = ((await devProjRes.json()) as ProjectResponse).project;
    expect(platformProj.devSettings).toBeNull();

    const generalProjRes = await harness.request(`/api/v1/workspaces/${wks1}/projects`, {
      method: "POST",
      cookieHeader: admin1.jar.toHeader(),
      json: { name: "General Ops", kind: "general", visibility: "workspace" },
    });
    const generalProj = ((await generalProjRes.json()) as ProjectResponse).project;

    const root1 = ((await (
      await harness.request(`/api/v1/projects/${platformProj.id}/tasks`, {
        method: "POST",
        cookieHeader: member1.jar.toHeader(),
        json: { title: "Existing root 1" },
      })
    ).json()) as TaskResponse).task;
    expect(root1.issueKey).toBeNull();
    expect(root1.branchName).toBeNull();

    const sub1 = ((await (
      await harness.request(`/api/v1/projects/${platformProj.id}/tasks`, {
        method: "POST",
        cookieHeader: member1.jar.toHeader(),
        json: {
          title: "Existing inherited subtask",
          parentTaskId: root1.id,
          inheritParentProject: true,
        },
      })
    ).json()) as TaskResponse).task;
    expect(sub1.projectId).toBeNull();
    expect(sub1.issueKey).toBeNull();

    const root2 = ((await (
      await harness.request(`/api/v1/projects/${platformProj.id}/tasks`, {
        method: "POST",
        cookieHeader: admin1.jar.toHeader(),
        json: { title: "Existing root 2" },
      })
    ).json()) as TaskResponse).task;

    // 3. Enabling fails while workspace feature is disabled
    const deniedEnableRes = await harness.request(
      `/api/v1/projects/${platformProj.id}/dev-settings/enable`,
      {
        method: "POST",
        cookieHeader: admin1.jar.toHeader(),
        json: { prefix: "prd" },
      },
    );
    expect(deniedEnableRes.status).toBe(403);
    expect(((await deniedEnableRes.json()) as ApiErrorResponse).error.messageKey).toBe(
      "error.devProjectsDisabled",
    );

    // 4. Enable workspace setting as admin, reject non-admin project activation
    const enableWsRes = await harness.request(`/api/v1/workspaces/${wks1}/settings`, {
      method: "PATCH",
      cookieHeader: admin1.jar.toHeader(),
      json: { devProjectsEnabled: true },
    });
    expect(enableWsRes.status).toBe(200);

    const memberEnableRes = await harness.request(
      `/api/v1/projects/${platformProj.id}/dev-settings/enable`,
      {
        method: "POST",
        cookieHeader: member1.jar.toHeader(),
        json: { prefix: "PRD" },
      },
    );
    expect(memberEnableRes.status).toBe(403);

    // 5. Enable dev project: normalizes prefix, defaults startStatusId to In Progress, backfills all 3 existing tasks (root + inherited subtask + root2)
    const enableProjRes = await harness.request(
      `/api/v1/projects/${platformProj.id}/dev-settings/enable`,
      {
        method: "POST",
        cookieHeader: admin1.jar.toHeader(),
        json: { prefix: " prd " },
      },
    );
    expect(enableProjRes.status).toBe(200);
    const enabledBody = (await enableProjRes.json()) as EnableDevProjectResponse;
    expect(enabledBody.keyedCount).toBe(3);
    expect(isValidEntityId("ins", enabledBody.dev.namespaceId)).toBe(true);
    expect(enabledBody.dev.prefix).toBe("PRD");
    expect(enabledBody.dev.branchPrefix).toBe("prd");
    expect(enabledBody.dev.oldPrefixes).toEqual([]);
    const inProgressStatus = platformProj.statuses.find(
      (s) => s.category === "in_progress",
    )!;
    expect(enabledBody.dev.startStatusId).toBe(inProgressStatus.id);

    const listAfterEnable = ((await (
      await harness.request(`/api/v1/projects/${platformProj.id}/tasks`, {
        cookieHeader: member1.jar.toHeader(),
      })
    ).json()) as TaskListResponse).tasks;
    const byIdAfterEnable = new Map(listAfterEnable.map((t) => [t.id, t]));
    expect(byIdAfterEnable.get(root1.id)?.issueKey).toBe("PRD-1");
    expect(byIdAfterEnable.get(root1.id)?.branchName).toBe("prd-1");
    expect(byIdAfterEnable.get(sub1.id)?.issueKey).toBe("PRD-2");
    expect(byIdAfterEnable.get(sub1.id)?.branchName).toBe("prd-2");
    expect(byIdAfterEnable.get(root2.id)?.issueKey).toBe("PRD-3");

    // 6. Unified creation paths: normal create (PRD-4), subtask (PRD-5), copy into dev (PRD-6), copy into general (null), delete PRD-5 -> next is PRD-7 (never reused)
    const createdRoot = ((await (
      await harness.request(`/api/v1/projects/${platformProj.id}/tasks`, {
        method: "POST",
        cookieHeader: member1.jar.toHeader(),
        json: { title: "New root 4" },
      })
    ).json()) as TaskResponse).task;
    expect(createdRoot.issueKey).toBe("PRD-4");
    expect(createdRoot.branchName).toBe("prd-4");

    const createdSub = ((await (
      await harness.request(`/api/v1/projects/${platformProj.id}/tasks`, {
        method: "POST",
        cookieHeader: member1.jar.toHeader(),
        json: { title: "New sub 5", parentTaskId: createdRoot.id },
      })
    ).json()) as TaskResponse).task;
    expect(createdSub.issueKey).toBe("PRD-5");

    const copiedInDev = ((await (
      await harness.request(`/api/v1/tasks/${createdRoot.id}/copy`, {
        method: "POST",
        cookieHeader: member1.jar.toHeader(),
        json: { title: "Copied in dev" },
      })
    ).json()) as TaskResponse).task;
    expect(isValidTaskPublicIdFormat(copiedInDev.id)).toBe(true);
    expect(copiedInDev.id).not.toBe(createdRoot.id);
    expect(copiedInDev.issueKey).toBe("PRD-6");
    expect(copiedInDev.branchName).toBe("prd-6");

    const copiedToGeneral = ((await (
      await harness.request(`/api/v1/tasks/${createdRoot.id}/copy`, {
        method: "POST",
        cookieHeader: member1.jar.toHeader(),
        json: { projectId: generalProj.id },
      })
    ).json()) as TaskResponse).task;
    expect(copiedToGeneral.effectiveProjectId).toBe(generalProj.id);
    expect(copiedToGeneral.issueKey).toBeNull();
    expect(copiedToGeneral.branchName).toBeNull();

    const delRes = await harness.request(`/api/v1/tasks/${createdSub.id}`, {
      method: "DELETE",
      cookieHeader: member1.jar.toHeader(),
    });
    expect(delRes.status).toBe(200);

    const afterDeleteTask = ((await (
      await harness.request(`/api/v1/projects/${platformProj.id}/tasks`, {
        method: "POST",
        cookieHeader: member1.jar.toHeader(),
        json: { title: "After delete 7" },
      })
    ).json()) as TaskResponse).task;
    expect(afterDeleteTask.issueKey).toBe("PRD-7");

    // 7. Prefix rename preserves branchName (`prd-7`) while changing display key (`CORE-7`) and reserving old prefix `PRD`
    const doneStatus = platformProj.statuses.find((s) => s.category === "done")!;
    const renameRes = await harness.request(
      `/api/v1/projects/${platformProj.id}/dev-settings`,
      {
        method: "PATCH",
        cookieHeader: admin1.jar.toHeader(),
        json: { prefix: "core", startStatusId: doneStatus.id },
      },
    );
    expect(renameRes.status).toBe(200);
    const renamed = (await renameRes.json()) as ProjectDevSettingsResponse;
    expect(renamed.dev?.prefix).toBe("CORE");
    expect(renamed.dev?.branchPrefix).toBe("prd");
    expect(renamed.dev?.oldPrefixes).toEqual(["PRD"]);
    expect(renamed.dev?.startStatusId).toBe(doneStatus.id);

    const readAfterRename = ((await (
      await harness.request(`/api/v1/tasks/${afterDeleteTask.id}`, {
        cookieHeader: member1.jar.toHeader(),
      })
    ).json()) as TaskResponse).task;
    expect(readAfterRename.issueKey).toBe("CORE-7");
    expect(readAfterRename.branchName).toBe("prd-7");

    // Workspace 1 other project cannot reuse old prefix `PRD` OR current `CORE`
    const thirdProjRes = await harness.request(`/api/v1/workspaces/${wks1}/projects`, {
      method: "POST",
      cookieHeader: admin1.jar.toHeader(),
      json: { name: "Mobile", kind: "general", visibility: "workspace" },
    });
    const mobileProj = ((await thirdProjRes.json()) as ProjectResponse).project;

    const reuseOldPrefixRes = await harness.request(
      `/api/v1/projects/${mobileProj.id}/dev-settings/enable`,
      {
        method: "POST",
        cookieHeader: admin1.jar.toHeader(),
        json: { prefix: "PRD" },
      },
    );
    expect(reuseOldPrefixRes.status).toBe(409);

    // Switching back to its OWN old prefix `PRD` is allowed
    const revertPrefixRes = await harness.request(
      `/api/v1/projects/${platformProj.id}/dev-settings`,
      {
        method: "PATCH",
        cookieHeader: admin1.jar.toHeader(),
        json: { prefix: "PRD" },
      },
    );
    expect(revertPrefixRes.status).toBe(200);
    expect(((await revertPrefixRes.json()) as ProjectDevSettingsResponse).dev?.oldPrefixes).toEqual([
      "CORE",
    ]);

    // Different workspace CAN use the exact same `PRD` and `CORE` prefixes independently
    await harness.request(`/api/v1/workspaces/${wks2}/settings`, {
      method: "PATCH",
      cookieHeader: admin2.jar.toHeader(),
      json: { devProjectsEnabled: true },
    });
    const ws2Proj = ((await (
      await harness.request(`/api/v1/workspaces/${wks2}/projects`, {
        method: "POST",
        cookieHeader: admin2.jar.toHeader(),
        json: { name: "Other WS Dev", kind: "general", visibility: "workspace" },
      })
    ).json()) as ProjectResponse).project;
    const ws2Enable = await harness.request(
      `/api/v1/projects/${ws2Proj.id}/dev-settings/enable`,
      {
        method: "POST",
        cookieHeader: admin2.jar.toHeader(),
        json: { prefix: "PRD" },
      },
    );
    expect(ws2Enable.status).toBe(200);
    const ws2Task = ((await (
      await harness.request(`/api/v1/projects/${ws2Proj.id}/tasks`, {
        method: "POST",
        cookieHeader: admin2.jar.toHeader(),
        json: { title: "WS2 First" },
      })
    ).json()) as TaskResponse).task;
    expect(ws2Task.issueKey).toBe("PRD-1");

    // 8. Revoking workspace setting blocks new activation & settings changes while keeping existing keys & task issuance working
    await harness.request(`/api/v1/workspaces/${wks1}/settings`, {
      method: "PATCH",
      cookieHeader: admin1.jar.toHeader(),
      json: { devProjectsEnabled: false },
    });
    const blockedEnableAfterRevoke = await harness.request(
      `/api/v1/projects/${mobileProj.id}/dev-settings/enable`,
      {
        method: "POST",
        cookieHeader: admin1.jar.toHeader(),
        json: { prefix: "MOB" },
      },
    );
    expect(blockedEnableAfterRevoke.status).toBe(403);

    const blockedSettingsPatch = await harness.request(
      `/api/v1/projects/${platformProj.id}/dev-settings`,
      {
        method: "PATCH",
        cookieHeader: admin1.jar.toHeader(),
        json: { prefix: "NEWP" },
      },
    );
    expect(blockedSettingsPatch.status).toBe(403);

    const stillWorksTask = ((await (
      await harness.request(`/api/v1/projects/${platformProj.id}/tasks`, {
        method: "POST",
        cookieHeader: member1.jar.toHeader(),
        json: { title: "Task after feature disable 8" },
      })
    ).json()) as TaskResponse).task;
    expect(stillWorksTask.issueKey).toBe("PRD-8");

    const listedProjects = ((await (
      await harness.request(`/api/v1/workspaces/${wks1}/projects`, {
        cookieHeader: member1.jar.toHeader(),
      })
    ).json()) as ProjectListResponse).projects;
    const listedPlatform = listedProjects.find((p) => p.id === platformProj.id);
    expect(listedPlatform?.devSettings?.prefix).toBe("PRD");
  });

  it("issues 50 duplicate-free sequential keys under 50-way concurrent creation across independent connections", async () => {
    const ctx = await createIsolatedDb();
    const setupDb = ctx.openClient();
    await setupDb.migrate();
    const ids = createSystemIdGenerator();

    const wksId = ids.next("wks");
    const adminId = ids.next("usr");
    const now = "2026-11-28T08:30:00.000Z";
    await setupDb.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "concurrent-50-ws",
        name: "Concurrent 50 Workspace",
        createdAt: now,
      });
      await repos.users.create({
        id: adminId,
        email: "conc50@example.com",
        displayName: "Concurrent Admin",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: adminId,
        role: "admin",
        createdAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksId,
        defaultLocale: "en",
        devProjectsEnabled: true,
        updatedAt: now,
      });
    });

    const actor = {
      userId: adminId,
      actorType: "user" as const,
      channel: "web" as const,
    };
    const setupWork = createWorkUseCases({
      uow: setupDb.uow,
      idGenerator: ids,
      clock: { now: () => new Date(now) },
    });
    const projRes = await setupWork.createProject(actor, wksId, {
      name: "Concurrent 50 Project",
      kind: "general",
      visibility: "workspace",
    });
    if (!projRes.ok) throw new Error("expected project");
    const projectId = projRes.data.project.id;

    const enabled = await setupWork.enableDevProject(actor, projectId, {
      prefix: "CONC",
    });
    expect(enabled.ok).toBe(true);

    // 10 independent DB clients × 5 concurrent tasks = 50 parallel creations behind one start barrier.
    const clientCount = 10;
    const tasksPerClient = 5;
    const totalTasks = clientCount * tasksPerClient;
    const workers = Array.from({ length: clientCount }, () => {
      const client =
        targetDb === "sqlite"
          ? ctx.openClient({
              busyTimeoutMs: 25,
              maxRetryAttempts: 80,
              retryBaseDelayMs: 5,
            })
          : ctx.openClient({
              maxPoolSize: 2,
              maxRetryAttempts: 10,
              retryBaseDelayMs: 20,
            });
      return createWorkUseCases({
        uow: client.uow,
        idGenerator: createSystemIdGenerator(),
        clock: { now: () => new Date(now) },
      });
    });

    const barrier = createBarrier(totalTasks);
    const results = await Promise.all(
      Array.from({ length: totalTasks }, async (_, idx) => {
        const work = workers[idx % workers.length]!;
        await barrier();
        return work.createTask(actor, projectId, {
          title: `Concurrent task #${idx}`,
        });
      }),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    const createdTasks = results.map((r) => {
      if (!r.ok) throw new Error(`unexpected failure: ${r.code}`);
      return r.data.task;
    });

    const publicIds = createdTasks.map((t) => t.id);
    expect(new Set(publicIds).size).toBe(totalTasks);

    const issueKeys = createdTasks.map((t) => t.issueKey);
    expect(new Set(issueKeys).size).toBe(totalTasks);

    const numbers = createdTasks
      .map((t) => extractIssueNumber(t.issueKey))
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: totalTasks }, (_, i) => i + 1));
    expect(
      createdTasks.every((t) => t.branchName === `conc-${extractIssueNumber(t.issueKey)}`),
    ).toBe(true);

    // Reopen fresh DB client to confirm committed rows + FK enforcement + exact outbox event count.
    const verifyClient = ctx.openClient();
    const verifyWork = createWorkUseCases({
      uow: verifyClient.uow,
      idGenerator: createSystemIdGenerator(),
      clock: { now: () => new Date(now) },
    });
    const listed = await verifyWork.listProjectTasks(actor, projectId);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.data.tasks).toHaveLength(totalTasks);
    }

    const events = await verifyClient.uow.run((repos) =>
      repos.outbox.listByWorkspace(wksId),
    );
    expect(events.filter((e) => e.eventType === "task.created")).toHaveLength(
      totalTasks,
    );
  });

  it("serializes concurrent enableDevProject against concurrent createTask calls with zero missing keys", async () => {
    const ctx = await createIsolatedDb();
    const setupDb = ctx.openClient();
    await setupDb.migrate();
    const ids = createSystemIdGenerator();

    const wksId = ids.next("wks");
    const adminId = ids.next("usr");
    const now = "2026-11-28T08:40:00.000Z";
    await setupDb.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "race-enable-ws",
        name: "Race Enable Workspace",
        createdAt: now,
      });
      await repos.users.create({
        id: adminId,
        email: "race-enable@example.com",
        displayName: "Race Admin",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: adminId,
        role: "admin",
        createdAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksId,
        defaultLocale: "en",
        devProjectsEnabled: true,
        updatedAt: now,
      });
    });

    const actor = {
      userId: adminId,
      actorType: "user" as const,
      channel: "web" as const,
    };
    const setupWork = createWorkUseCases({
      uow: setupDb.uow,
      idGenerator: ids,
      clock: { now: () => new Date(now) },
    });
    const projRes = await setupWork.createProject(actor, wksId, {
      name: "Race Project",
      kind: "general",
      visibility: "workspace",
    });
    if (!projRes.ok) throw new Error("expected project");
    const projectId = projRes.data.project.id;

    const createCount = 12;
    const taskWorkers = Array.from({ length: createCount }, () => {
      const client =
        targetDb === "sqlite"
          ? ctx.openClient({
              busyTimeoutMs: 25,
              maxRetryAttempts: 60,
              retryBaseDelayMs: 5,
            })
          : ctx.openClient({ maxPoolSize: 2, maxRetryAttempts: 8 });
      return createWorkUseCases({
        uow: client.uow,
        idGenerator: createSystemIdGenerator(),
        clock: { now: () => new Date(now) },
      });
    });

    const enableClient =
      targetDb === "sqlite"
        ? ctx.openClient({
            busyTimeoutMs: 25,
            maxRetryAttempts: 60,
            retryBaseDelayMs: 5,
          })
        : ctx.openClient({ maxPoolSize: 2, maxRetryAttempts: 8 });
    const enableWork = createWorkUseCases({
      uow: enableClient.uow,
      idGenerator: createSystemIdGenerator(),
      clock: { now: () => new Date(now) },
    });

    const barrier = createBarrier(createCount + 1);
    const createPromises = taskWorkers.map(async (work, idx) => {
      await barrier();
      return work.createTask(actor, projectId, { title: `Race task ${idx}` });
    });
    const enablePromise = (async () => {
      await barrier();
      return enableWork.enableDevProject(actor, projectId, { prefix: "RACE" });
    })();

    const [enableResult, createResults] = await Promise.all([
      enablePromise,
      Promise.all(createPromises),
    ]);

    expect(enableResult.ok).toBe(true);
    expect(createResults.every((r) => r.ok)).toBe(true);

    const listed = await setupWork.listProjectTasks(actor, projectId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("expected list");

    expect(listed.data.tasks).toHaveLength(createCount);
    expect(listed.data.tasks.every((t) => t.issueKey !== null)).toBe(true);
    const numbers = listed.data.tasks
      .map((t) => extractIssueNumber(t.issueKey))
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: createCount }, (_, i) => i + 1));
  });

  it("enforces DB constraints on duplicate prefixes, duplicate numbers, and malformed prefixes", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const ids = createSystemIdGenerator();
    const now = "2026-11-28T08:50:00.000Z";
    const wksId = ids.next("wks");
    const ns1 = ids.next("ins");
    const ns2 = ids.next("ins");

    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "constraints-ws",
        name: "Constraints WS",
        createdAt: now,
      });
    });

    // Properly create 2 projects + namespaces + task for DB constraint checks
    const prj1 = ids.next("prj");
    const prj2 = ids.next("prj");
    const tsk1 = ids.next("tsk");
    const tsk2 = ids.next("tsk");
    await db.uow.run(async (repos) => {
      await repos.projects.create({
        id: prj1,
        workspaceId: wksId,
        kind: "development",
        visibility: "workspace",
        name: "P1",
        description: "",
        createdAt: now,
      });
      await repos.projects.create({
        id: prj2,
        workspaceId: wksId,
        kind: "development",
        visibility: "workspace",
        name: "P2",
        description: "",
        createdAt: now,
      });
      await repos.issueKeys.createNamespace({
        id: ns1,
        workspaceId: wksId,
        projectId: prj1,
        currentPrefix: "UNQ",
        branchPrefix: "unq",
        startStatusId: null,
        enabledBy: null,
        enabledAt: now,
      });
      await repos.issueKeys.createNamespace({
        id: ns2,
        workspaceId: wksId,
        projectId: prj2,
        currentPrefix: "TWO",
        branchPrefix: "two",
        startStatusId: null,
        enabledBy: null,
        enabledAt: now,
      });
      await repos.tasks.create({
        id: tsk1,
        workspaceId: wksId,
        projectId: prj1,
        parentTaskId: null,
        statusId: null,
        title: "T1",
        description: "",
        assigneeId: null,
        createdBy: null,
        dueOn: null,
        position: 0,
        createdAt: now,
      });
      await repos.tasks.create({
        id: tsk2,
        workspaceId: wksId,
        projectId: prj1,
        parentTaskId: null,
        statusId: null,
        title: "T2",
        description: "",
        assigneeId: null,
        createdBy: null,
        dueOn: null,
        position: 0,
        createdAt: now,
      });
      await repos.issueKeys.createTaskKeys([
        { taskId: tsk1, namespaceId: ns1, issueNumber: 1, createdAt: now },
      ]);
    });

    const mapErr = targetDb === "sqlite" ? mapSqliteError : mapPostgresError;

    // 1. Duplicate (workspace_id, prefix)
    let dupPrefixErr: unknown;
    try {
      await db.kysely
        .insertInto("issue_key_prefixes")
        .values({
          workspace_id: wksId,
          prefix: "DUP",
          namespace_id: ns1,
          created_at: now,
        })
        .execute();
      await db.kysely
        .insertInto("issue_key_prefixes")
        .values({
          workspace_id: wksId,
          prefix: "DUP",
          namespace_id: ns2,
          created_at: now,
        })
        .execute();
    } catch (error) {
      dupPrefixErr = error;
    }
    expect(() => mapErr(dupPrefixErr)).toThrow();
    try {
      mapErr(dupPrefixErr);
    } catch (mapped) {
      expect(isPersistenceError(mapped, "UNIQUE_VIOLATION")).toBe(true);
    }

    // 2. Duplicate (namespace_id, issue_number)
    let dupNumErr: unknown;
    try {
      await db.kysely
        .insertInto("task_issue_keys")
        .values({
          task_id: tsk2,
          namespace_id: ns1,
          issue_number: 1,
          created_at: now,
        })
        .execute();
    } catch (error) {
      dupNumErr = error;
    }
    try {
      mapErr(dupNumErr);
    } catch (mapped) {
      expect(isPersistenceError(mapped, "UNIQUE_VIOLATION")).toBe(true);
    }

    // 3. Invalid prefix CHECK constraint
    let badPrefixErr: unknown;
    try {
      await db.kysely
        .insertInto("issue_key_prefixes")
        .values({
          workspace_id: wksId,
          prefix: "1BAD",
          namespace_id: ns1,
          created_at: now,
        })
        .execute();
    } catch (error) {
      badPrefixErr = error;
    }
    try {
      mapErr(badPrefixErr);
    } catch (mapped) {
      expect(isPersistenceError(mapped, "CHECK_VIOLATION")).toBe(true);
    }
  });
});
