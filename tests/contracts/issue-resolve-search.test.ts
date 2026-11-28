import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSystemIdGenerator,
  createWorkUseCases,
  type UnitOfWork,
} from "@prood/application";
import type {
  ApiErrorResponse,
  DbDriverKind,
  EnableDevProjectResponse,
  MeResponse,
  ProjectResponse,
  TaskListResponse,
  TaskResponse,
  TaskSearchResponse,
} from "@prood/contracts";
import { createBetterAuthAdapter } from "@prood/integration-better-auth";
import type { KyselyBackedDatabaseClient } from "@prood/persistence-common";
import {
  createPostgresDatabase,
  createPostgresSchema,
  dropPostgresSchema,
} from "@prood/persistence-postgres";
import {
  createSqliteDatabase,
  openSqliteConnection,
} from "@prood/persistence-sqlite";
import { createApp } from "@prood/server/app";

const targetDb = process.env.PROOD_TEST_DB as DbDriverKind | undefined;
if (targetDb !== "sqlite" && targetDb !== "postgres") {
  throw new Error(
    `PROOD_TEST_DB must be "sqlite" or "postgres" (received: ${String(targetDb)})`,
  );
}

const BASE_URL = "http://127.0.0.1:3000";
const AUTH_SECRET = "prood-resolve-search-test-secret-at-least-32-chars!";

interface IsolatedDb {
  openClient(): KyselyBackedDatabaseClient;
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
    const dir = mkdtempSync(join(tmpdir(), "prood-resolve-sqlite-"));
    const filePath = join(dir, "resolve.sqlite");
    const ctx: IsolatedDb = {
      sqliteFilePath: filePath,
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

  const schema = `prood_resolve_${Date.now().toString(36)}_${Math.random()
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
  startTimeIso = "2026-11-28T09:30:00.000Z",
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

describe(`Issue resolution, move visibility & search (${targetDb})`, () => {
  it("resolves tasks & projects identically by ID, current key, and old key while hiding existence of unreadable keys and respecting access revocation", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const ids = createSystemIdGenerator();
    const harness = createServerHarness(db);

    const wksId = ids.next("wks");
    const now = "2026-11-28T09:00:00.000Z";
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "resolve-ws",
        name: "Resolve Workspace",
        createdAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksId,
        defaultLocale: "en",
        devProjectsEnabled: true,
        updatedAt: now,
      });
    });

    const admin = await harness.signUpUser("admin-res@example.com", "Admin");
    const privMember = await harness.signUpUser("priv-member@example.com", "Priv Member");
    const openMember = await harness.signUpUser("open-member@example.com", "Open Member");
    const viewer = await harness.signUpUser("viewer-res@example.com", "Viewer");

    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: admin.userId,
        role: "admin",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: privMember.userId,
        role: "member",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: openMember.userId,
        role: "member",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: viewer.userId,
        role: "viewer",
        createdAt: now,
      });
    });

    // Open dev project PRD -> renamed to CORE
    const openProj = ((await (
      await harness.request(`/api/v1/workspaces/${wksId}/projects`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { name: "Open Dev", kind: "general", visibility: "workspace" },
      })
    ).json()) as ProjectResponse).project;
    await harness.request(`/api/v1/projects/${openProj.id}/dev-settings/enable`, {
      method: "POST",
      cookieHeader: admin.jar.toHeader(),
      json: { prefix: "PRD" },
    });

    const openRoot = ((await (
      await harness.request(`/api/v1/projects/${openProj.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "Open Root Task", description: "First root" },
      })
    ).json()) as TaskResponse).task;
    const openSub = ((await (
      await harness.request(`/api/v1/projects/${openProj.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: {
          title: "Open Inherited Subtask",
          parentTaskId: openRoot.id,
          inheritParentProject: true,
        },
      })
    ).json()) as TaskResponse).task;

    await harness.request(`/api/v1/projects/${openProj.id}/dev-settings`, {
      method: "PATCH",
      cookieHeader: admin.jar.toHeader(),
      json: { prefix: "CORE" },
    });

    // Private dev project OLDPRIV -> renamed to PRIV, granted only to admin & privMember
    const privProj = ((await (
      await harness.request(`/api/v1/workspaces/${wksId}/projects`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { name: "Private Dev", kind: "general", visibility: "private" },
      })
    ).json()) as ProjectResponse).project;
    await db.uow.run((repos) =>
      repos.projects.upsertMembership({
        id: ids.next("mbr"),
        projectId: privProj.id,
        userId: privMember.userId,
        role: "member",
        createdAt: now,
      }),
    );
    await harness.request(`/api/v1/projects/${privProj.id}/dev-settings/enable`, {
      method: "POST",
      cookieHeader: admin.jar.toHeader(),
      json: { prefix: "OLDPRIV" },
    });
    const privRoot = ((await (
      await harness.request(`/api/v1/projects/${privProj.id}/tasks`, {
        method: "POST",
        cookieHeader: privMember.jar.toHeader(),
        json: { title: "Secret Root Title" },
      })
    ).json()) as TaskResponse).task;
    const privSub = ((await (
      await harness.request(`/api/v1/projects/${privProj.id}/tasks`, {
        method: "POST",
        cookieHeader: privMember.jar.toHeader(),
        json: {
          title: "Secret Inherited Subtask",
          parentTaskId: privRoot.id,
          inheritParentProject: true,
        },
      })
    ).json()) as TaskResponse).task;
    await harness.request(`/api/v1/projects/${privProj.id}/dev-settings`, {
      method: "PATCH",
      cookieHeader: admin.jar.toHeader(),
      json: { prefix: "PRIV" },
    });

    // 1. Unified resolution: ID, current key, old key, lowercase key all return identical task & project
    for (const ref of [openRoot.id, "CORE-1", "PRD-1", "prd-1", "core-1"]) {
      const res = await harness.request(`/api/v1/tasks/${ref}`, {
        cookieHeader: openMember.jar.toHeader(),
      });
      expect(res.status).toBe(200);
      const task = ((await res.json()) as TaskResponse).task;
      expect(task.id).toBe(openRoot.id);
      expect(task.issueKey).toBe("CORE-1");
      expect(task.branchName).toBe("prd-1");
    }

    // Inherited subtask resolves by ID, current key (CORE-2), and old key (PRD-2)
    for (const subRef of [openSub.id, "CORE-2", "PRD-2"]) {
      const res = await harness.request(`/api/v1/tasks/${subRef}`, {
        cookieHeader: openMember.jar.toHeader(),
      });
      expect(res.status).toBe(200);
      const task = ((await res.json()) as TaskResponse).task;
      expect(task.id).toBe(openSub.id);
      expect(task.projectId).toBeNull();
      expect(task.effectiveProjectId).toBe(openProj.id);
      expect(task.issueKey).toBe("CORE-2");
    }

    // Project ref resolution by ID, current prefix, and old prefix
    for (const projRef of [openProj.id, "CORE", "PRD", "prd"]) {
      const res = await harness.request(
        `/api/v1/workspaces/${wksId}/projects/${projRef}`,
        { cookieHeader: openMember.jar.toHeader() },
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as ProjectResponse).project.id).toBe(openProj.id);
    }

    // Viewer gets identical read (200) and write denial (403) across ID, current key, and old key
    for (const ref of [openRoot.id, "CORE-1", "PRD-1"]) {
      expect(
        (
          await harness.request(`/api/v1/tasks/${ref}`, {
            cookieHeader: viewer.jar.toHeader(),
          })
        ).status,
      ).toBe(200);
      const viewerPatch = await harness.request(`/api/v1/tasks/${ref}`, {
        method: "PATCH",
        cookieHeader: viewer.jar.toHeader(),
        json: { title: "Denied Update" },
      });
      expect(viewerPatch.status).toBe(403);
      expect(((await viewerPatch.json()) as ApiErrorResponse).error.code).toBe(
        "FORBIDDEN",
      );
    }

    // 2. Non-member gets identical 404 responses for non-existent vs unreadable ID/current key/old key
    const readBodies: string[] = [];
    const patchBodies: string[] = [];
    for (const ref of ["NOPE-999", privSub.id, "PRIV-2", "OLDPRIV-2"]) {
      const getRes = await harness.request(`/api/v1/tasks/${ref}`, {
        cookieHeader: openMember.jar.toHeader(),
      });
      expect(getRes.status).toBe(404);
      readBodies.push(await getRes.text());

      const patchRes = await harness.request(`/api/v1/tasks/${ref}`, {
        method: "PATCH",
        cookieHeader: openMember.jar.toHeader(),
        json: { title: "Should Not Leak" },
      });
      expect(patchRes.status).toBe(404);
      patchBodies.push(await patchRes.text());
    }
    expect(new Set(readBodies).size).toBe(1);
    expect(new Set(patchBodies).size).toBe(1);

    // 3. Access revocation: removing privMember from privProj immediately blocks ID, current key, old key, and search
    expect(
      (
        await harness.request(`/api/v1/tasks/OLDPRIV-2`, {
          cookieHeader: privMember.jar.toHeader(),
        })
      ).status,
    ).toBe(200);

    await db.uow.run((repos) =>
      repos.projects.deleteMembership(privProj.id, privMember.userId),
    );

    for (const ref of [privSub.id, "PRIV-2", "OLDPRIV-2"]) {
      const res = await harness.request(`/api/v1/tasks/${ref}`, {
        cookieHeader: privMember.jar.toHeader(),
      });
      expect(res.status).toBe(404);
    }

    // Removing openMember from workspace revokes open-project key resolution and search
    expect(
      (
        await harness.request(`/api/v1/tasks/CORE-1`, {
          cookieHeader: openMember.jar.toHeader(),
        })
      ).status,
    ).toBe(200);

    await db.uow.run((repos) =>
      repos.memberships.deleteByWorkspaceAndUser(wksId, openMember.userId),
    );

    expect(
      (
        await harness.request(`/api/v1/tasks/CORE-1`, {
          cookieHeader: openMember.jar.toHeader(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await harness.request(`/api/v1/workspaces/${wksId}/tasks/search?q=CORE-1`, {
          cookieHeader: openMember.jar.toHeader(),
        })
      ).status,
    ).toBe(403);
  });

  it("hides display keys after move to a general project while still resolving/searching old keys, issues keys on move to dev project, and disambiguates cross-workspace keys", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const ids = createSystemIdGenerator();
    const harness = createServerHarness(db);

    const wksA = ids.next("wks");
    const wksB = ids.next("wks");
    const now = "2026-11-28T09:10:00.000Z";
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksA,
        slug: "move-ws-a",
        name: "Move WS A",
        createdAt: now,
      });
      await repos.workspaces.create({
        id: wksB,
        slug: "move-ws-b",
        name: "Move WS B",
        createdAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksA,
        defaultLocale: "en",
        devProjectsEnabled: true,
        updatedAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksB,
        defaultLocale: "en",
        devProjectsEnabled: true,
        updatedAt: now,
      });
    });

    const admin = await harness.signUpUser("move-admin@example.com", "Move Admin");
    const memberA = await harness.signUpUser("move-member@example.com", "Move Member");
    await db.uow.run(async (repos) => {
      for (const wksId of [wksA, wksB]) {
        await repos.memberships.create({
          id: ids.next("mbr"),
          workspaceId: wksId,
          userId: admin.userId,
          role: "admin",
          createdAt: now,
        });
      }
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksA,
        userId: memberA.userId,
        role: "member",
        createdAt: now,
      });
    });

    const createDevProject = async (wksId: string, name: string, prefix: string) => {
      const proj = ((await (
        await harness.request(`/api/v1/workspaces/${wksId}/projects`, {
          method: "POST",
          cookieHeader: admin.jar.toHeader(),
          json: { name, kind: "general", visibility: "workspace" },
        })
      ).json()) as ProjectResponse).project;
      const enableRes = await harness.request(
        `/api/v1/projects/${proj.id}/dev-settings/enable`,
        {
          method: "POST",
          cookieHeader: admin.jar.toHeader(),
          json: { prefix },
        },
      );
      expect(enableRes.status).toBe(200);
      expect(((await enableRes.json()) as EnableDevProjectResponse).dev.prefix).toBe(prefix);
      return proj;
    };

    const devA = await createDevProject(wksA, "Dev Alpha", "ALF");
    await harness.request(`/api/v1/projects/${devA.id}/dev-settings`, {
      method: "PATCH",
      cookieHeader: admin.jar.toHeader(),
      json: { prefix: "BETA" },
    });
    const devB = await createDevProject(wksA, "Dev Gamma", "GAM");
    const generalProj = ((await (
      await harness.request(`/api/v1/workspaces/${wksA}/projects`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { name: "General Inbox", kind: "general", visibility: "workspace" },
      })
    ).json()) as ProjectResponse).project;
    const privGeneral = ((await (
      await harness.request(`/api/v1/workspaces/${wksA}/projects`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { name: "Private General", kind: "general", visibility: "private" },
      })
    ).json()) as ProjectResponse).project;

    // Task + inherited subtask in devA (BETA-1 / BETA-2, old prefix ALF)
    const root1 = ((await (
      await harness.request(`/api/v1/projects/${devA.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "Portable feature" },
      })
    ).json()) as TaskResponse).task;
    const sub1 = ((await (
      await harness.request(`/api/v1/projects/${devA.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "Portable child", parentTaskId: root1.id },
      })
    ).json()) as TaskResponse).task;
    // Task mentioning ALF-1 / BETA-1 in title + Japanese text task
    const followUp = ((await (
      await harness.request(`/api/v1/projects/${generalProj.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "Follow up on ALF-1 and BETA-1", description: "Text mention" },
      })
    ).json()) as TaskResponse).task;
    const jpTask = ((await (
      await harness.request(`/api/v1/projects/${generalProj.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "認証フローの設計確認", description: "日本語検索の確認" },
      })
    ).json()) as TaskResponse).task;
    const jpChild = ((await (
      await harness.request(`/api/v1/projects/${generalProj.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "日本語サブタスク", parentTaskId: jpTask.id },
      })
    ).json()) as TaskResponse).task;
    const privTask = ((await (
      await harness.request(`/api/v1/projects/${privGeneral.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "Confidential BETA-1 token" },
      })
    ).json()) as TaskResponse).task;

    // 1. Move BETA-1 (along with inherited sub1 BETA-2) from devA -> generalProj
    const movedToGenRes = await harness.request(`/api/v1/tasks/BETA-1/move`, {
      method: "POST",
      cookieHeader: admin.jar.toHeader(),
      json: { projectId: generalProj.id },
    });
    expect(movedToGenRes.status).toBe(200);
    const movedToGen = ((await movedToGenRes.json()) as TaskResponse).task;
    expect(movedToGen.effectiveProjectId).toBe(generalProj.id);
    // Display key MUST be hidden after moving to a general project
    expect(movedToGen.issueKey).toBeNull();
    expect(movedToGen.branchName).toBeNull();

    // Still resolves cleanly by old/issued keys AND ID for an authorized member, still hiding display key
    for (const ref of [root1.id, "BETA-1", "ALF-1"]) {
      const readRes = await harness.request(`/api/v1/tasks/${ref}`, {
        cookieHeader: memberA.jar.toHeader(),
      });
      expect(readRes.status).toBe(200);
      const t = ((await readRes.json()) as TaskResponse).task;
      expect(t.id).toBe(root1.id);
      expect(t.issueKey).toBeNull();
      expect(t.branchName).toBeNull();
    }
    const readSubMoved = ((await (
      await harness.request(`/api/v1/tasks/ALF-2`, {
        cookieHeader: memberA.jar.toHeader(),
      })
    ).json()) as TaskResponse).task;
    expect(readSubMoved.id).toBe(sub1.id);
    expect(readSubMoved.issueKey).toBeNull();

    // General project task list shows null issueKey for moved tasks
    const genList = ((await (
      await harness.request(`/api/v1/projects/${generalProj.id}/tasks`, {
        cookieHeader: memberA.jar.toHeader(),
      })
    ).json()) as TaskListResponse).tasks;
    expect(genList.find((t) => t.id === root1.id)?.issueKey).toBeNull();

    // 2. Search exact match ordering & visibility filtering
    const keySearch = ((await (
      await harness.request(`/api/v1/workspaces/${wksA}/tasks/search?q=alf-1`, {
        cookieHeader: memberA.jar.toHeader(),
      })
    ).json()) as TaskSearchResponse);
    expect(keySearch.items[0]?.matchKind).toBe("exact_key");
    expect(keySearch.items[0]?.task.id).toBe(root1.id);
    expect(keySearch.items[0]?.task.issueKey).toBeNull();
    expect(keySearch.items[1]?.matchKind).toBe("text");
    expect(keySearch.items[1]?.task.id).toBe(followUp.id);
    // Private general task mentioning ALF-1/BETA-1 must NOT appear for memberA
    expect(keySearch.items.some((i) => i.task.id === privTask.id)).toBe(false);

    const idSearch = ((await (
      await harness.request(`/api/v1/workspaces/${wksA}/tasks/search?q=${root1.id}`, {
        cookieHeader: memberA.jar.toHeader(),
      })
    ).json()) as TaskSearchResponse);
    expect(idSearch.items[0]?.matchKind).toBe("exact_id");
    expect(idSearch.items[0]?.task.id).toBe(root1.id);

    const jpSearch = ((await (
      await harness.request(
        `/api/v1/workspaces/${wksA}/tasks/search?q=${encodeURIComponent("認証フロー")}`,
        { cookieHeader: memberA.jar.toHeader() },
      )
    ).json()) as TaskSearchResponse);
    expect(jpSearch.items.map((i) => i.task.id)).toEqual([jpTask.id]);

    // 3. Move unkeyed general task (with inherited subtask) into devB -> issues GAM-1 and GAM-2
    const movedGenToDevB = ((await (
      await harness.request(`/api/v1/tasks/${jpTask.id}/move`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { projectId: devB.id },
      })
    ).json()) as TaskResponse).task;
    expect(movedGenToDevB.issueKey).toBe("GAM-1");
    const jpChildAfterMove = ((await (
      await harness.request(`/api/v1/tasks/${jpChild.id}`, {
        cookieHeader: memberA.jar.toHeader(),
      })
    ).json()) as TaskResponse).task;
    expect(jpChildAfterMove.issueKey).toBe("GAM-2");

    // 4. Move already-keyed task (BETA-1 / ALF-1) into devB -> preserves ALF/BETA origin namespace!
    const movedGenToDevBKeyed = ((await (
      await harness.request(`/api/v1/tasks/ALF-1/move`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { projectId: devB.id },
      })
    ).json()) as TaskResponse).task;
    expect(movedGenToDevBKeyed.issueKey).toBe("BETA-1");
    expect(movedGenToDevBKeyed.branchName).toBe("alf-1");

    // 5. Move ALF-1 into privGeneral -> memberA loses access even via old key ALF-1 and search
    await harness.request(`/api/v1/tasks/ALF-1/move`, {
      method: "POST",
      cookieHeader: admin.jar.toHeader(),
      json: { projectId: privGeneral.id },
    });
    expect(
      (
        await harness.request(`/api/v1/tasks/ALF-1`, {
          cookieHeader: memberA.jar.toHeader(),
        })
      ).status,
    ).toBe(404);
    const searchPrivateMoved = ((await (
      await harness.request(`/api/v1/workspaces/${wksA}/tasks/search?q=ALF-1`, {
        cookieHeader: memberA.jar.toHeader(),
      })
    ).json()) as TaskSearchResponse);
    expect(searchPrivateMoved.items.some((i) => i.task.id === root1.id)).toBe(false);

    // 6. Cross-workspace key isolation & unscoped disambiguation
    const devWsB = await createDevProject(wksB, "WS B Beta", "BETA");
    const wsBTask = ((await (
      await harness.request(`/api/v1/projects/${devWsB.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "Workspace B BETA-1" },
      })
    ).json()) as TaskResponse).task;
    expect(wsBTask.issueKey).toBe("BETA-1");

    // Admin can see BOTH wksA and wksB BETA-1 -> unscoped returns 409 CONFLICT, scoped returns the target workspace's task
    const ambiguousRes = await harness.request(`/api/v1/tasks/BETA-1`, {
      cookieHeader: admin.jar.toHeader(),
    });
    expect(ambiguousRes.status).toBe(409);
    expect(((await ambiguousRes.json()) as ApiErrorResponse).error.messageKey).toBe(
      "error.ambiguousIssueKey",
    );

    const scopedBRes = await harness.request(
      `/api/v1/workspaces/${wksB}/tasks/BETA-1`,
      { cookieHeader: admin.jar.toHeader() },
    );
    expect(scopedBRes.status).toBe(200);
    expect(((await scopedBRes.json()) as TaskResponse).task.id).toBe(wsBTask.id);

    // Query plan check on SQLite for exact-key index lookup
    if (targetDb === "sqlite" && ctx.sqliteFilePath) {
      const sqliteConn = openSqliteConnection(ctx.sqliteFilePath);
      try {
        const rows = sqliteConn
          .prepare(
            "EXPLAIN QUERY PLAN SELECT task_issue_keys.task_id FROM issue_key_prefixes INNER JOIN task_issue_keys ON task_issue_keys.namespace_id = issue_key_prefixes.namespace_id WHERE issue_key_prefixes.workspace_id = ? AND issue_key_prefixes.prefix = ? AND task_issue_keys.issue_number = ?",
          )
          .all(wksB, "BETA", 1) as Array<{ detail: string }>;
        const plan = rows.map((r) => r.detail).join(" | ");
        expect(plan).not.toContain("SCAN issue_key_prefixes");
        expect(plan).not.toContain("SCAN task_issue_keys");
      } finally {
        sqliteConn.close();
      }
    }
  });

  it("detaches source-project children, maps inherited descendant statuses on move, and paginates search past disallowed or out-of-scope null-project subtasks", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const ids = createSystemIdGenerator();
    const harness = createServerHarness(db, "2026-11-28T10:00:00.000Z");

    const wksId = ids.next("wks");
    const now = "2026-11-28T10:00:00.000Z";
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "move-search-hardening-ws",
        name: "Move & Search Hardening WS",
        createdAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksId,
        defaultLocale: "en",
        devProjectsEnabled: true,
        updatedAt: now,
      });
    });

    const admin = await harness.signUpUser("hardening-admin@example.com", "Admin");
    const bWriter = await harness.signUpUser("hardening-writer@example.com", "B Writer");
    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: admin.userId,
        role: "admin",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: bWriter.userId,
        role: "member",
        createdAt: now,
      });
    });

    const privA = ((await (
      await harness.request(`/api/v1/workspaces/${wksId}/projects`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { name: "Private Source A", kind: "general", visibility: "private" },
      })
    ).json()) as ProjectResponse).project;
    const openB = ((await (
      await harness.request(`/api/v1/workspaces/${wksId}/projects`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { name: "Open Target B", kind: "general", visibility: "workspace" },
      })
    ).json()) as ProjectResponse).project;
    await harness.request(`/api/v1/projects/${openB.id}/dev-settings/enable`, {
      method: "POST",
      cookieHeader: admin.jar.toHeader(),
      json: { prefix: "OPENB" },
    });
    const openC = ((await (
      await harness.request(`/api/v1/workspaces/${wksId}/projects`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { name: "Open Other C", kind: "general", visibility: "workspace" },
      })
    ).json()) as ProjectResponse).project;

    const aInProgress = privA.statuses.find((s) => s.category === "in_progress")!;
    const aDone = privA.statuses.find((s) => s.category === "done")!;
    const bTodo = openB.statuses.find((s) => s.category === "todo")!;
    const bInProgress = openB.statuses.find((s) => s.category === "in_progress")!;
    const bDone = openB.statuses.find((s) => s.category === "done")!;

    // P in privA with:
    // - C1 (inheritParentProject: false -> remains in privA) + C1Sub
    // - C2 (inheritParentProject: true -> moves to openB, status In Progress -> maps to B's In Progress)
    //   - G1 under C2 (inheritParentProject: false -> remains in privA, must detach from C2)
    //   - G2 under C2 (inheritParentProject: true -> moves to openB, status Done -> maps to B's Done)
    const pTask = ((await (
      await harness.request(`/api/v1/projects/${privA.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "Moveable Root P" },
      })
    ).json()) as TaskResponse).task;
    const c1Task = ((await (
      await harness.request(`/api/v1/projects/${privA.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: {
          title: "Stays in PrivA C1",
          parentTaskId: pTask.id,
          inheritParentProject: false,
          statusId: aDone.id,
        },
      })
    ).json()) as TaskResponse).task;
    const c1Sub = ((await (
      await harness.request(`/api/v1/projects/${privA.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "Child of C1", parentTaskId: c1Task.id },
      })
    ).json()) as TaskResponse).task;
    const c2Task = ((await (
      await harness.request(`/api/v1/projects/${privA.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: {
          title: "Inherited C2",
          parentTaskId: pTask.id,
          inheritParentProject: true,
          statusId: aInProgress.id,
        },
      })
    ).json()) as TaskResponse).task;
    const g1Task = ((await (
      await harness.request(`/api/v1/projects/${privA.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: {
          title: "Non-inherited under C2",
          parentTaskId: c2Task.id,
          inheritParentProject: false,
          statusId: aDone.id,
        },
      })
    ).json()) as TaskResponse).task;
    const g2Task = ((await (
      await harness.request(`/api/v1/projects/${privA.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: {
          title: "Inherited Grandchild G2",
          parentTaskId: c2Task.id,
          inheritParentProject: true,
          statusId: aDone.id,
        },
      })
    ).json()) as TaskResponse).task;

    // Move P from privA -> openB
    const moveRes = await harness.request(`/api/v1/tasks/${pTask.id}/move`, {
      method: "POST",
      cookieHeader: admin.jar.toHeader(),
      json: { projectId: openB.id },
    });
    expect(moveRes.status).toBe(200);
    const movedP = ((await moveRes.json()) as TaskResponse).task;
    expect(movedP.effectiveProjectId).toBe(openB.id);
    expect(movedP.statusId).toBe(bTodo.id);

    // 1. Verify C1 and G1 were detached and retained privA project + privA Done status
    const readC1 = ((await (
      await harness.request(`/api/v1/tasks/${c1Task.id}`, {
        cookieHeader: admin.jar.toHeader(),
      })
    ).json()) as TaskResponse).task;
    expect(readC1.parentTaskId).toBeNull();
    expect(readC1.effectiveProjectId).toBe(privA.id);
    expect(readC1.statusId).toBe(aDone.id);

    const readG1 = ((await (
      await harness.request(`/api/v1/tasks/${g1Task.id}`, {
        cookieHeader: admin.jar.toHeader(),
      })
    ).json()) as TaskResponse).task;
    expect(readG1.parentTaskId).toBeNull();
    expect(readG1.effectiveProjectId).toBe(privA.id);
    expect(readG1.statusId).toBe(aDone.id);

    // 2. Verify inherited C2 and G2 moved to openB AND had statuses mapped cleanly
    const readC2 = ((await (
      await harness.request(`/api/v1/tasks/${c2Task.id}`, {
        cookieHeader: bWriter.jar.toHeader(),
      })
    ).json()) as TaskResponse).task;
    expect(readC2.effectiveProjectId).toBe(openB.id);
    expect(readC2.statusId).toBe(bInProgress.id);

    const readG2 = ((await (
      await harness.request(`/api/v1/tasks/${g2Task.id}`, {
        cookieHeader: bWriter.jar.toHeader(),
      })
    ).json()) as TaskResponse).task;
    expect(readG2.effectiveProjectId).toBe(openB.id);
    expect(readG2.statusId).toBe(bDone.id);

    const listB = ((await (
      await harness.request(`/api/v1/projects/${openB.id}/tasks`, {
        cookieHeader: bWriter.jar.toHeader(),
      })
    ).json()) as TaskListResponse).tasks;
    expect(listB.find((t) => t.id === c2Task.id)?.statusId).toBe(bInProgress.id);
    expect(listB.find((t) => t.id === g2Task.id)?.statusId).toBe(bDone.id);
    expect(listB.some((t) => t.id === c1Task.id || t.id === g1Task.id)).toBe(false);

    // Passing C2's mapped statusId back to PATCH must succeed
    const patchC2 = await harness.request(`/api/v1/tasks/${c2Task.id}`, {
      method: "PATCH",
      cookieHeader: bWriter.jar.toHeader(),
      json: { statusId: readC2.statusId, title: "Inherited C2 updated" },
    });
    expect(patchC2.status).toBe(200);

    // 3. B-only writer (no access to privA) deletes P -> C2 & G2 cascade, C1/C1Sub/G1 in privA survive intact!
    const delPRes = await harness.request(`/api/v1/tasks/${pTask.id}`, {
      method: "DELETE",
      cookieHeader: bWriter.jar.toHeader(),
    });
    expect(delPRes.status).toBe(200);

    for (const survivedId of [c1Task.id, c1Sub.id, g1Task.id]) {
      const checkRes = await harness.request(`/api/v1/tasks/${survivedId}`, {
        cookieHeader: admin.jar.toHeader(),
      });
      expect(checkRes.status).toBe(200);
    }

    // 4. Search pagination past >50 disallowed / out-of-scope null-project subtasks with limit=1
    const targetInB = ((await (
      await harness.request(`/api/v1/projects/${openB.id}/tasks`, {
        method: "POST",
        cookieHeader: bWriter.jar.toHeader(),
        json: { title: "Older horizon-signal target in B" },
      })
    ).json()) as TaskResponse).task;

    // Create 55 newer matching inherited subtasks in private privA + 5 in openC (all project_id = NULL)
    const privParent = ((await (
      await harness.request(`/api/v1/projects/${privA.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "Noise container in PrivA" },
      })
    ).json()) as TaskResponse).task;
    const cParent = ((await (
      await harness.request(`/api/v1/projects/${openC.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "Noise container in OpenC" },
      })
    ).json()) as TaskResponse).task;

    await db.uow.run(async (repos) => {
      for (let i = 0; i < 55; i += 1) {
        const ts = `2026-11-28T11:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`;
        await repos.tasks.create({
          id: ids.next("tsk"),
          workspaceId: wksId,
          projectId: null,
          parentTaskId: privParent.id,
          statusId: null,
          title: `Newer horizon-signal priv noise ${i}`,
          description: "",
          assigneeId: null,
          createdBy: admin.userId,
          dueOn: null,
          position: i,
          createdAt: ts,
        });
      }
      for (let i = 0; i < 5; i += 1) {
        const ts = `2026-11-28T11:01:${String(i).padStart(2, "0")}.000Z`;
        await repos.tasks.create({
          id: ids.next("tsk"),
          workspaceId: wksId,
          projectId: null,
          parentTaskId: cParent.id,
          statusId: null,
          title: `Newer horizon-signal openC noise ${i}`,
          description: "",
          assigneeId: null,
          createdBy: admin.userId,
          dueOn: null,
          position: i,
          createdAt: ts,
        });
      }
    });

    // Workspace search with limit=1 by bWriter (cannot read privA): skips all 55 privA subtasks and returns 1 readable match (from openC)
    const wsSearchLimit1 = ((await (
      await harness.request(
        `/api/v1/workspaces/${wksId}/tasks/search?q=horizon-signal&limit=1`,
        { cookieHeader: bWriter.jar.toHeader() },
      )
    ).json()) as TaskSearchResponse);
    expect(wsSearchLimit1.items).toHaveLength(1);
    expect(wsSearchLimit1.items[0]?.task.effectiveProjectId).not.toBe(privA.id);

    // Project-scoped search for openB with limit=1 skips all 60 newer null-project noise rows (55 privA + 5 openC) and finds targetInB!
    const scopedLimit1 = ((await (
      await harness.request(
        `/api/v1/workspaces/${wksId}/tasks/search?q=horizon-signal&projectId=${openB.id}&limit=1`,
        { cookieHeader: bWriter.jar.toHeader() },
      )
    ).json()) as TaskSearchResponse);
    expect(scopedLimit1.items).toHaveLength(1);
    expect(scopedLimit1.items[0]?.task.id).toBe(targetInB.id);

    // Exact key search with limit=1 keeps exact match priority
    const exactKeyLimit1 = ((await (
      await harness.request(
        `/api/v1/workspaces/${wksId}/tasks/search?q=${targetInB.issueKey}&limit=1`,
        { cookieHeader: bWriter.jar.toHeader() },
      )
    ).json()) as TaskSearchResponse);
    expect(exactKeyLimit1.items).toHaveLength(1);
    expect(exactKeyLimit1.items[0]?.matchKind).toBe("exact_key");
    expect(exactKeyLimit1.items[0]?.task.id).toBe(targetInB.id);
  });

  it("normalizes Unicode case-folding consistently across SQLite and PostgreSQL search", async () => {
    const isolated = await createIsolatedDb();
    const db = isolated.openClient();
    await db.migrate();
    const harness = createServerHarness(db);
    const ids = createSystemIdGenerator();

    const wksId = ids.next("wks");
    const now = "2026-11-28T11:30:00.000Z";
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "unicode-search-ws",
        name: "Unicode Search WS",
        createdAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksId,
        defaultLocale: "en",
        devProjectsEnabled: true,
        updatedAt: now,
      });
    });

    const admin = await harness.signUpUser("unicode-admin@example.com", "Admin");
    const member = await harness.signUpUser("unicode-member@example.com", "Member");
    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: admin.userId,
        role: "admin",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: member.userId,
        role: "member",
        createdAt: now,
      });
    });

    const openProj = ((await (
      await harness.request(`/api/v1/workspaces/${wksId}/projects`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { name: "Open Unicode", kind: "general", visibility: "workspace" },
      })
    ).json()) as ProjectResponse).project;
    const privProj = ((await (
      await harness.request(`/api/v1/workspaces/${wksId}/projects`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { name: "Private Unicode", kind: "general", visibility: "private" },
      })
    ).json()) as ProjectResponse).project;

    const ecoleTask = ((await (
      await harness.request(`/api/v1/projects/${openProj.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: {
          title: "École supérieure architecture",
          description: "Café résumé notes",
        },
      })
    ).json()) as TaskResponse).task;
    const uberTask = ((await (
      await harness.request(`/api/v1/projects/${openProj.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "ÜBER review" },
      })
    ).json()) as TaskResponse).task;
    const jaTask = ((await (
      await harness.request(`/api/v1/projects/${openProj.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "認証フローの設計確認" },
      })
    ).json()) as TaskResponse).task;

    // Create private parent + >50 newer inherited private subtasks matching "École"
    const privParent = ((await (
      await harness.request(`/api/v1/projects/${privProj.id}/tasks`, {
        method: "POST",
        cookieHeader: admin.jar.toHeader(),
        json: { title: "École secrète" },
      })
    ).json()) as TaskResponse).task;

    await db.uow.run(async (repos) => {
      for (let i = 0; i < 55; i += 1) {
        const ts = `2026-11-28T12:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`;
        await repos.tasks.create({
          id: ids.next("tsk"),
          workspaceId: wksId,
          projectId: null,
          parentTaskId: privParent.id,
          statusId: null,
          title: `École secrète noise ${i}`,
          description: "",
          assigneeId: null,
          createdBy: admin.userId,
          dueOn: null,
          position: i,
          createdAt: ts,
        });
      }
    });

    for (const q of ["École", "école", "ÉCOLE", "E\u0301cole", "café"]) {
      const res = await harness.request(
        `/api/v1/workspaces/${wksId}/tasks/search?q=${encodeURIComponent(q)}&limit=1`,
        { cookieHeader: member.jar.toHeader() },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as TaskSearchResponse;
      expect(body.items.map((item) => item.task.id)).toEqual([ecoleTask.id]);
    }

    for (const q of ["über", "Über"]) {
      const res = await harness.request(
        `/api/v1/workspaces/${wksId}/tasks/search?q=${encodeURIComponent(q)}`,
        { cookieHeader: member.jar.toHeader() },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as TaskSearchResponse;
      expect(body.items.map((item) => item.task.id)).toEqual([uberTask.id]);
    }

    const jaRes = await harness.request(
      `/api/v1/workspaces/${wksId}/tasks/search?q=${encodeURIComponent("認証フロー")}`,
      { cookieHeader: member.jar.toHeader() },
    );
    expect(jaRes.status).toBe(200);
    expect(((await jaRes.json()) as TaskSearchResponse).items.map((i) => i.task.id)).toEqual([
      jaTask.id,
    ]);
  });

  it("serializes task authorization with concurrent project moves to a private project", async () => {
    const isolated = await createIsolatedDb();
    const db = isolated.openClient();
    await db.migrate();
    const dbSecond = isolated.openClient();
    const ids = createSystemIdGenerator();
    let tick = Date.parse("2026-11-28T12:00:00.000Z");
    const clock = {
      now: () => {
        tick += 1000;
        return new Date(tick);
      },
    };

    const wksId = ids.next("wks");
    const adminUserId = ids.next("usr");
    const memberUserId = ids.next("usr");
    const now = "2026-11-28T12:00:00.000Z";

    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "move-race-ws",
        name: "Move Race WS",
        createdAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksId,
        defaultLocale: "en",
        devProjectsEnabled: false,
        updatedAt: now,
      });
      await repos.users.create({
        id: adminUserId,
        email: "race-admin@example.com",
        displayName: "Admin",
        createdAt: now,
      });
      await repos.users.create({
        id: memberUserId,
        email: "race-member@example.com",
        displayName: "Member",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: adminUserId,
        role: "admin",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: memberUserId,
        role: "member",
        createdAt: now,
      });
    });

    const adminActor = {
      userId: adminUserId,
      actorType: "user",
      channel: "web",
    } as const;
    const memberActor = {
      userId: memberUserId,
      actorType: "user",
      channel: "web",
    } as const;

    const adminWork = createWorkUseCases({ uow: db.uow, idGenerator: ids, clock });
    const memberWork = createWorkUseCases({ uow: dbSecond.uow, idGenerator: ids, clock });

    const openARes = await adminWork.createProject(adminActor, wksId, {
      name: "Open A",
      kind: "general",
      visibility: "workspace",
    });
    expect(openARes.ok).toBe(true);
    if (!openARes.ok) throw new Error("setup failed");
    const openA = openARes.data.project;

    const privBRes = await adminWork.createProject(adminActor, wksId, {
      name: "Private B",
      kind: "general",
      visibility: "private",
    });
    expect(privBRes.ok).toBe(true);
    if (!privBRes.ok) throw new Error("setup failed");
    const privateB = privBRes.data.project;

    const directT1 = await adminWork.createTask(adminActor, openA.id, {
      title: "Original Direct T1",
    });
    const directT2 = await adminWork.createTask(adminActor, openA.id, {
      title: "Original Direct T2",
    });
    const parentP1 = await adminWork.createTask(adminActor, openA.id, {
      title: "Parent P1",
    });
    if (!directT1.ok || !directT2.ok || !parentP1.ok) {
      throw new Error("setup failed");
    }
    const inheritedC1 = await adminWork.createTask(adminActor, openA.id, {
      title: "Original Inherited C1",
      parentTaskId: parentP1.data.task.id,
      inheritParentProject: true,
    });
    const parentP2 = await adminWork.createTask(adminActor, openA.id, {
      title: "Parent P2",
    });
    if (!inheritedC1.ok || !parentP2.ok) {
      throw new Error("setup failed");
    }

    if (targetDb === "postgres") {
      function createGatedMoveWork(): {
        work: ReturnType<typeof createWorkUseCases>;
        afterUpdate: Promise<void>;
        releaseCommit: () => void;
      } {
        let markAfterUpdate!: () => void;
        let markReleaseCommit!: () => void;
        const afterUpdate = new Promise<void>((resolve) => {
          markAfterUpdate = resolve;
        });
        const releaseGate = new Promise<void>((resolve) => {
          markReleaseCommit = resolve;
        });
        let paused = false;

        const gatedUow: UnitOfWork = {
          run: (fn) =>
            db.uow.run((repos) =>
              fn({
                ...repos,
                tasks: {
                  ...repos.tasks,
                  update: async (id, patch) => {
                    const updated = await repos.tasks.update(id, patch);
                    if (!paused) {
                      paused = true;
                      markAfterUpdate();
                      await releaseGate;
                    }
                    return updated;
                  },
                },
              }),
            ),
        };

        return {
          work: createWorkUseCases({ uow: gatedUow, idGenerator: ids, clock }),
          afterUpdate,
          releaseCommit: markReleaseCommit,
        };
      }

      // 1. Direct task update vs move to privateB
      {
        const gate = createGatedMoveWork();
        const movePromise = gate.work.moveTask(adminActor, directT1.data.task.id, {
          projectId: privateB.id,
        });
        await gate.afterUpdate;

        let memberSettled = false;
        const memberPromise = memberWork
          .updateTask(memberActor, directT1.data.task.id, {
            title: "Hijacked Direct T1",
          })
          .finally(() => {
            memberSettled = true;
          });

        await new Promise((r) => setTimeout(r, 80));
        expect(memberSettled).toBe(false);

        gate.releaseCommit();
        const [moveRes, memberRes] = await Promise.all([movePromise, memberPromise]);
        expect(moveRes.ok).toBe(true);
        expect(memberRes.ok).toBe(false);
        if (!memberRes.ok) {
          expect(memberRes.status).toBe(404);
        }
        const readAfter = await adminWork.getTask(adminActor, directT1.data.task.id);
        expect(readAfter.ok).toBe(true);
        if (readAfter.ok) {
          expect(readAfter.data.task.effectiveProjectId).toBe(privateB.id);
          expect(readAfter.data.task.title).toBe("Original Direct T1");
        }
      }

      // 2. Direct task delete vs move to privateB
      {
        const gate = createGatedMoveWork();
        const movePromise = gate.work.moveTask(adminActor, directT2.data.task.id, {
          projectId: privateB.id,
        });
        await gate.afterUpdate;

        const memberPromise = memberWork.deleteTask(
          memberActor,
          directT2.data.task.id,
        );
        await new Promise((r) => setTimeout(r, 60));
        gate.releaseCommit();

        const [moveRes, memberRes] = await Promise.all([movePromise, memberPromise]);
        expect(moveRes.ok).toBe(true);
        expect(memberRes.ok).toBe(false);
        if (!memberRes.ok) {
          expect(memberRes.status).toBe(404);
        }
        const readAfter = await adminWork.getTask(adminActor, directT2.data.task.id);
        expect(readAfter.ok).toBe(true);
        if (readAfter.ok) {
          expect(readAfter.data.task.effectiveProjectId).toBe(privateB.id);
        }
      }

      // 3. Inherited subtask update vs ancestor parent move to privateB
      {
        const gate = createGatedMoveWork();
        const movePromise = gate.work.moveTask(adminActor, parentP1.data.task.id, {
          projectId: privateB.id,
        });
        await gate.afterUpdate;

        let memberSettled = false;
        const memberPromise = memberWork
          .updateTask(memberActor, inheritedC1.data.task.id, {
            title: "Hijacked Inherited C1",
          })
          .finally(() => {
            memberSettled = true;
          });

        await new Promise((r) => setTimeout(r, 80));
        expect(memberSettled).toBe(false);

        gate.releaseCommit();
        const [moveRes, memberRes] = await Promise.all([movePromise, memberPromise]);
        expect(moveRes.ok).toBe(true);
        expect(memberRes.ok).toBe(false);
        if (!memberRes.ok) {
          expect(memberRes.status).toBe(404);
        }
        const readAfter = await adminWork.getTask(adminActor, inheritedC1.data.task.id);
        expect(readAfter.ok).toBe(true);
        if (readAfter.ok) {
          expect(readAfter.data.task.effectiveProjectId).toBe(privateB.id);
          expect(readAfter.data.task.title).toBe("Original Inherited C1");
        }
      }

      // 4. Inherited subtask create under parent vs parent move to privateB
      {
        const gate = createGatedMoveWork();
        const movePromise = gate.work.moveTask(adminActor, parentP2.data.task.id, {
          projectId: privateB.id,
        });
        await gate.afterUpdate;

        const memberPromise = memberWork.createTask(memberActor, openA.id, {
          title: "Hijacked Subtask Under P2",
          parentTaskId: parentP2.data.task.id,
        });
        await new Promise((r) => setTimeout(r, 60));
        gate.releaseCommit();

        const [moveRes, memberRes] = await Promise.all([movePromise, memberPromise]);
        expect(moveRes.ok).toBe(true);
        expect(memberRes.ok).toBe(false);
        if (!memberRes.ok) {
          // parentP2 moved into unreadable privateB -> 404 prevents an existence oracle
          expect(memberRes.status).toBe(404);
        }
      }
    } else {
      // SQLite uses BEGIN IMMEDIATE single-writer serialization; verify concurrent dispatch resolves cleanly.
      const [moveRes, memberRes] = await Promise.all([
        adminWork.moveTask(adminActor, directT1.data.task.id, {
          projectId: privateB.id,
        }),
        memberWork.updateTask(memberActor, directT1.data.task.id, {
          title: "SQLite Race Title",
        }),
      ]);
      expect(moveRes.ok).toBe(true);
      const readAfter = await adminWork.getTask(adminActor, directT1.data.task.id);
      expect(readAfter.ok).toBe(true);
      if (readAfter.ok) {
        expect(readAfter.data.task.effectiveProjectId).toBe(privateB.id);
        expect(readAfter.data.task.title).toBe(
          memberRes.ok ? "SQLite Race Title" : "Original Direct T1",
        );
      }
    }
  });
});
