import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSystemIdGenerator,
  createWorkUseCases,
  type TransactionRepositories,
  type UnitOfWork,
} from "@prood/application";
import {
  CONTRACT_VERSION,
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
  type ApiErrorResponse,
  type DbDriverKind,
  type McpToolErrorPayload,
  type MeResponse,
  type ProjectDto,
  type ProjectListResponse,
  type ProjectResponse,
  type TaskListResponse,
  type TaskResponse,
  type TaskSearchResponse,
} from "@prood/contracts";
import { createBetterAuthAdapter } from "@prood/integration-better-auth";
import { createProodMcpServer } from "@prood/integration-fastmcp";
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
import {
  createApp,
  createNodeAppListener,
  mountWebShellAssets,
} from "@prood/server";

const targetDb = process.env.PROOD_TEST_DB as DbDriverKind | undefined;
if (targetDb !== "sqlite" && targetDb !== "postgres") {
  throw new Error(
    `PROOD_TEST_DB must be "sqlite" or "postgres" (received: ${String(targetDb)})`,
  );
}

const AUTH_SECRET = "prood-mcp-pr10-test-secret-at-least-32-chars";

interface IsolatedDb {
  openClient(options?: {
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
    const dir = mkdtempSync(join(tmpdir(), "prood-mcp-pr10-sqlite-"));
    const filePath = join(dir, "pr10.sqlite");
    const ctx: IsolatedDb = {
      sqliteFilePath: filePath,
      openClient(opts) {
        const client = createSqliteDatabase({
          filePath,
          ...(opts?.busyTimeoutMs !== undefined
            ? { busyTimeoutMs: opts.busyTimeoutMs }
            : {}),
          maxRetryAttempts: opts?.maxRetryAttempts ?? 6,
          retryBaseDelayMs: opts?.retryBaseDelayMs ?? 25,
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

  const schema = `prood_pr10_${Date.now().toString(36)}_${Math.random()
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
        maxRetryAttempts: opts?.maxRetryAttempts ?? 6,
        retryBaseDelayMs: opts?.retryBaseDelayMs ?? 25,
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

function createPkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function startTestHttpServer(db: KyselyBackedDatabaseClient) {
  const httpServer: HttpServer = createServer();
  await new Promise<void>((resolveListen) => {
    httpServer.listen(0, "127.0.0.1", () => resolveListen());
  });
  cleanups.push(
    () =>
      new Promise<void>((resolveClose, rejectClose) => {
        httpServer.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  );

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind ephemeral HTTP test port");
  }
  const baseURL = `http://127.0.0.1:${address.port}`;
  const mcpResource = `${baseURL}/mcp`;

  const auth = createBetterAuthAdapter({
    db,
    secret: AUTH_SECRET,
    baseURL,
    trustedOrigins: [baseURL],
    mcpResource,
  });

  const clock = { now: () => new Date() };
  const idGenerator = createSystemIdGenerator();
  const workUseCases = createWorkUseCases({
    uow: db.uow,
    idGenerator,
    clock,
  });

  const mcpHandler = createProodMcpServer({
    resource: mcpResource,
    tokenVerifier: auth,
    uow: db.uow,
    idGenerator,
    clock,
    trustedOrigins: [baseURL],
    onAuthFailure: (info) =>
      workUseCases.recordEntryAuthFailure({
        channel: "mcp",
        path: info.path,
        reasonCode: info.reasonCode,
        detail: info.detail,
      }),
  });
  cleanups.push(async () => {
    await mcpHandler.close?.();
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

  mountWebShellAssets(app, resolve(process.cwd(), "apps/web/dist"));
  httpServer.on("request", createNodeAppListener(app));

  async function signUpUser(email: string, name: string) {
    const jar = new CookieJar();
    const res = await fetch(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL },
      body: JSON.stringify({
        email,
        password: "mcp-pr10-password-123",
        name,
      }),
    });
    expect(res.status).toBe(200);
    jar.updateFrom(res);
    const meRes = await fetch(`${baseURL}/api/v1/me`, {
      headers: { cookie: jar.toHeader() },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as MeResponse;
    return { jar, userId: me.user.id, email: me.user.email };
  }

  async function webJson<T>(
    path: string,
    jar: CookieJar,
    init: {
      method?: string;
      json?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${baseURL}${path}`, {
      method: init.method ?? "GET",
      headers: {
        origin: baseURL,
        cookie: jar.toHeader(),
        ...(init.json !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...init.headers,
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    return { status: res.status, data: (await res.json()) as T };
  }

  async function issueOAuthAccessToken(jar: CookieJar, scope: string) {
    const redirectUri = "http://127.0.0.1:49152/callback";
    const asRes = await fetch(`${baseURL}/.well-known/oauth-authorization-server`);
    expect(asRes.status).toBe(200);
    const asMeta = (await asRes.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
    };

    const regRes = await fetch(asMeta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Prood PR10 Test Client",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope,
      }),
    });
    expect(regRes.status).toBe(201);
    const clientReg = (await regRes.json()) as { client_id: string };

    const { verifier, challenge } = createPkcePair();
    const state = randomBytes(12).toString("hex");
    const authUrl = new URL(asMeta.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientReg.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", scope);
    authUrl.searchParams.set("resource", mcpResource);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    const authRes = await fetch(authUrl.toString(), {
      method: "GET",
      headers: { accept: "text/html", cookie: jar.toHeader() },
      redirect: "manual",
    });
    jar.updateFrom(authRes);
    let location = authRes.headers.get("location");
    if (authRes.status === 200) {
      const json = (await authRes.json()) as { url?: string };
      location = json.url ?? null;
    } else {
      expect(authRes.status).toBe(302);
    }
    expect(location).toBeTruthy();

    const redirectTarget = new URL(location!, baseURL);
    let code = redirectTarget.searchParams.get("code");
    if (!code) {
      const consentRes = await fetch(`${baseURL}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: baseURL,
          cookie: jar.toHeader(),
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: redirectTarget.search.replace(/^\?/, ""),
        }),
      });
      expect(consentRes.status).toBe(200);
      jar.updateFrom(consentRes);
      const consentJson = (await consentRes.json()) as { url: string };
      code = new URL(consentJson.url).searchParams.get("code");
    }
    expect(code).toBeTruthy();

    const tokenRes = await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: redirectUri,
        client_id: clientReg.client_id,
        code_verifier: verifier,
        resource: mcpResource,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenJson = (await tokenRes.json()) as { access_token: string };
    return {
      accessToken: tokenJson.access_token,
      clientId: clientReg.client_id,
    };
  }

  async function connectMcpClient(accessToken: string) {
    const client = new Client({ name: "prood-pr10-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpResource), {
      requestInit: {
        headers: { authorization: `Bearer ${accessToken}` },
      },
    });
    await client.connect(transport);
    cleanups.push(async () => {
      await client.close();
    });
    return client;
  }

  return {
    baseURL,
    mcpResource,
    workUseCases,
    signUpUser,
    webJson,
    issueOAuthAccessToken,
    connectMcpClient,
  };
}

function readToolText(result: unknown): string {
  const record =
    result && typeof result === "object"
      ? (result as { content?: unknown })
      : {};
  const items = Array.isArray(record.content)
    ? (record.content as Array<{ type: string; text?: string }>)
    : [];
  const textItem = items.find((item) => item.type === "text");
  expect(textItem?.text).toBeTruthy();
  return textItem!.text!;
}

function parseToolSuccess<T>(result: unknown): T {
  const record =
    result && typeof result === "object"
      ? (result as { isError?: unknown })
      : {};
  expect(record.isError).not.toBe(true);
  return JSON.parse(readToolText(result)) as T;
}

function parseToolError(result: unknown): McpToolErrorPayload {
  const record =
    result && typeof result === "object"
      ? (result as { isError?: unknown })
      : {};
  expect(record.isError).toBe(true);
  return JSON.parse(readToolText(result)) as McpToolErrorPayload;
}

describe(`MCP read tools & idempotent task creation (${targetDb})`, () => {
  it("upgrades from v6 to v7 preserving existing workspaces, dev keys, and FK integrity", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    const usrId = ids.next("usr");
    const now = "2026-11-28T09:00:00.000Z";

    await db.migrate({ targetVersion: 6 });
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "v6-legacy",
        name: "V6 Workspace",
        createdAt: now,
      });
      await repos.users.create({
        id: usrId,
        email: "v6-admin@example.com",
        displayName: "V6 Admin",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: usrId,
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

    const prjId = ids.next("prj");
    const nsId = ids.next("ins");
    const tskId = ids.next("tsk");
    await db.uow.run(async (repos) => {
      await repos.projects.create({
        id: prjId,
        workspaceId: wksId,
        kind: "development",
        visibility: "workspace",
        name: "Legacy App",
        description: "",
        createdAt: now,
      });
      await repos.projects.upsertMembership({
        id: ids.next("mbr"),
        projectId: prjId,
        userId: usrId,
        role: "admin",
        createdAt: now,
      });
      await repos.issueKeys.createNamespace({
        id: nsId,
        workspaceId: wksId,
        projectId: prjId,
        currentPrefix: "LEG",
        branchPrefix: "leg",
        startStatusId: null,
        enabledBy: usrId,
        enabledAt: now,
      });
      await repos.issueKeys.reservePrefix({
        workspaceId: wksId,
        prefix: "LEG",
        namespaceId: nsId,
        createdAt: now,
      });
      await repos.issueKeys.initCounter(nsId, 2);
      await repos.tasks.create({
        id: tskId,
        workspaceId: wksId,
        projectId: prjId,
        parentTaskId: null,
        statusId: null,
        title: "Pre-v7 task",
        description: "",
        assigneeId: null,
        createdBy: usrId,
        dueOn: null,
        position: 0,
        createdAt: now,
      });
      await repos.issueKeys.createTaskKeys([
        { taskId: tskId, namespaceId: nsId, issueNumber: 1, createdAt: now },
      ]);
    });

    const work = createWorkUseCases({
      uow: db.uow,
      idGenerator: ids,
      clock: { now: () => new Date(now) },
    });
    const actor = {
      userId: usrId,
      actorType: "user" as const,
      channel: "web" as const,
    };

    const upgrade = await db.migrate();
    expect(upgrade).toEqual({ appliedVersions: [7, 8, 9], currentVersion: 9 });

    const fetched = await work.getTask(actor, "LEG-1", { workspaceId: wksId });
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.data.task.id).toBe(tskId);
      expect(fetched.data.task.issueKey).toBe("LEG-1");
    }

    if (ctx.sqliteFilePath) {
      const raw = await openSqliteConnection(ctx.sqliteFilePath);
      try {
        expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
        expect(raw.pragma("foreign_key_check")).toEqual([]);
      } finally {
        raw.close();
      }
    }
  });

  it("supports MCP reads by public ID, current/historical key, and project prefix with unified visibility and scopes", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const server = await startTestHttpServer(db);
    const ids = createSystemIdGenerator();
    const now = "2026-11-28T10:00:00.000Z";

    const admin1 = await server.signUpUser("admin1@example.com", "Admin One");
    const member1 = await server.signUpUser("member1@example.com", "Member One");
    const admin2 = await server.signUpUser("admin2@example.com", "Admin Two");

    const wks1 = ids.next("wks");
    const wks2 = ids.next("wks");
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wks1,
        slug: "mcp-ws-1",
        name: "MCP Workspace 1",
        createdAt: now,
      });
      await repos.workspaces.create({
        id: wks2,
        slug: "mcp-ws-2",
        name: "MCP Workspace 2",
        createdAt: now,
      });
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
        userId: admin1.userId,
        role: "admin",
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

    await server.webJson(`/api/v1/workspaces/${wks1}/settings`, admin1.jar, {
      method: "PATCH",
      json: { devProjectsEnabled: true },
    });
    await server.webJson(`/api/v1/workspaces/${wks2}/settings`, admin2.jar, {
      method: "PATCH",
      json: { devProjectsEnabled: true },
    });

    const pubProjRes = await server.webJson<{ project: ProjectDto }>(
      `/api/v1/workspaces/${wks1}/projects`,
      admin1.jar,
      {
        method: "POST",
        json: { name: "Public App", visibility: "workspace" },
      },
    );
    const privProjRes = await server.webJson<{ project: ProjectDto }>(
      `/api/v1/workspaces/${wks1}/projects`,
      admin1.jar,
      {
        method: "POST",
        json: { name: "Secret Vault", visibility: "private" },
      },
    );
    const ws2ProjRes = await server.webJson<{ project: ProjectDto }>(
      `/api/v1/workspaces/${wks2}/projects`,
      admin2.jar,
      {
        method: "POST",
        json: { name: "Second Workspace App", visibility: "workspace" },
      },
    );
    const pubProj = pubProjRes.data.project;
    const privProj = privProjRes.data.project;
    const ws2Proj = ws2ProjRes.data.project;

    await server.webJson(`/api/v1/projects/${pubProj.id}/dev-settings/enable`, admin1.jar, {
      method: "POST",
      json: { prefix: "PRD" },
    });
    await server.webJson(`/api/v1/projects/${privProj.id}/dev-settings/enable`, admin1.jar, {
      method: "POST",
      json: { prefix: "SEC" },
    });
    // Also claim APP in ws2, and SHARED in both ws1 (private) and ws2 (workspace)
    await server.webJson(`/api/v1/projects/${ws2Proj.id}/dev-settings/enable`, admin2.jar, {
      method: "POST",
      json: { prefix: "APP" },
    });

    const parentWeb = await server.webJson<TaskResponse>(
      `/api/v1/projects/${pubProj.id}/tasks`,
      admin1.jar,
      {
        method: "POST",
        json: { title: "Core auth issue" },
      },
    );
    expect(parentWeb.status).toBe(201);
    const parentTask = parentWeb.data.task;
    expect(parentTask.issueKey).toBe("PRD-1");

    const subWeb = await server.webJson<TaskResponse>(
      `/api/v1/projects/${pubProj.id}/tasks`,
      admin1.jar,
      {
        method: "POST",
        json: {
          title: "Inherited MCP subtask",
          parentTaskId: parentTask.id,
          inheritParentProject: true,
        },
      },
    );
    expect(subWeb.status).toBe(201);
    expect(subWeb.data.task.projectId).toBeNull();
    expect(subWeb.data.task.issueKey).toBe("PRD-2");

    const privTaskWeb = await server.webJson<TaskResponse>(
      `/api/v1/projects/${privProj.id}/tasks`,
      admin1.jar,
      {
        method: "POST",
        json: { title: "Hidden secret work" },
      },
    );
    const privTask = privTaskWeb.data.task;

    // Rename PRD -> APP in ws1, keeping PRD as historical prefix!
    await server.webJson(`/api/v1/projects/${pubProj.id}/dev-settings`, admin1.jar, {
      method: "PATCH",
      json: { prefix: "APP" },
    });

    const readOnlyToken = await server.issueOAuthAccessToken(
      member1.jar,
      `openid profile email ${MCP_READ_SCOPE}`,
    );
    const readClient = await server.connectMcpClient(readOnlyToken.accessToken);

    const listedTools = await readClient.listTools();
    expect(listedTools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "whoami",
        "list_projects",
        "get_project",
        "list_tasks",
        "get_task",
        "search_tasks",
        "create_task",
      ]),
    );

    // list_projects only sees pubProj (not privProj, not ws2Proj)
    const projectsRes = parseToolSuccess<ProjectListResponse>(
      await readClient.callTool({ name: "list_projects", arguments: {} }),
    );
    expect(projectsRes.projects.map((p) => p.id)).toEqual([pubProj.id]);

    // get_project works via prj_*, current prefix APP, and old prefix PRD
    for (const ref of [pubProj.id, "APP", "PRD"]) {
      const pRes = parseToolSuccess<ProjectResponse>(
        await readClient.callTool({
          name: "get_project",
          arguments: { projectRef: ref },
        }),
      );
      expect(pRes.project.id).toBe(pubProj.id);
    }

    // get_task by tsk_*, current key APP-1, and old key PRD-1 returns IDENTICAL tsk_* ID
    const byId = parseToolSuccess<TaskResponse>(
      await readClient.callTool({ name: "get_task", arguments: { taskRef: parentTask.id } }),
    );
    const byNewKey = parseToolSuccess<TaskResponse>(
      await readClient.callTool({ name: "get_task", arguments: { taskRef: "APP-1" } }),
    );
    const byOldKey = parseToolSuccess<TaskResponse>(
      await readClient.callTool({ name: "get_task", arguments: { taskRef: "PRD-1" } }),
    );
    expect(byId.task.id).toBe(parentTask.id);
    expect(byNewKey.task.id).toBe(parentTask.id);
    expect(byOldKey.task.id).toBe(parentTask.id);
    expect(byOldKey.task.issueKey).toBe("APP-1");

    // Inherited subtask visible via list_tasks and get_task by key
    const listedTasks = parseToolSuccess<TaskListResponse>(
      await readClient.callTool({ name: "list_tasks", arguments: { projectRef: "PRD" } }),
    );
    expect(listedTasks.tasks.map((t) => t.id)).toEqual(
      expect.arrayContaining([parentTask.id, subWeb.data.task.id]),
    );
    const subByKey = parseToolSuccess<TaskResponse>(
      await readClient.callTool({ name: "get_task", arguments: { taskRef: "PRD-2" } }),
    );
    expect(subByKey.task.id).toBe(subWeb.data.task.id);
    expect(subByKey.task.issueKey).toBe("APP-2");

    // search_tasks finds by old key, current key, and keyword; hides private project tasks
    const searchOldKey = parseToolSuccess<TaskSearchResponse>(
      await readClient.callTool({ name: "search_tasks", arguments: { query: "PRD-1" } }),
    );
    expect(searchOldKey.items[0]?.matchKind).toBe("exact_key");
    expect(searchOldKey.items[0]?.task.id).toBe(parentTask.id);

    const searchSecret = parseToolSuccess<TaskSearchResponse>(
      await readClient.callTool({ name: "search_tasks", arguments: { query: "Hidden secret" } }),
    );
    expect(searchSecret.items).toHaveLength(0);

    // Non-member reads of private project & private task hide existence (NOT_FOUND) + write denied outbox
    const deniedPrivProj = parseToolError(
      await readClient.callTool({ name: "get_project", arguments: { projectRef: "SEC" } }),
    );
    expect(deniedPrivProj.error).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      messageKey: "error.notFound",
    });
    const deniedPrivTask = parseToolError(
      await readClient.callTool({ name: "get_task", arguments: { taskRef: privTask.id } }),
    );
    expect(deniedPrivTask.error.status).toBe(404);

    // Read-only token must fail OAuth scope check when attempting create_task
    await expect(
      readClient.callTool({
        name: "create_task",
        arguments: {
          projectRef: "APP",
          title: "Should fail scope",
          idempotencyKey: "k-readonly-scope",
        },
      }),
    ).rejects.toThrow();

    // Cross-workspace prefix ambiguity for admin1 who is in both ws1 (APP) and ws2 (APP)
    const admin1Token = await server.issueOAuthAccessToken(
      admin1.jar,
      `openid profile email ${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
    );
    const admin1Client = await server.connectMcpClient(admin1Token.accessToken);
    const ambiguousProj = parseToolError(
      await admin1Client.callTool({ name: "get_project", arguments: { projectRef: "APP" } }),
    );
    expect(ambiguousProj.error).toMatchObject({
      code: "CONFLICT",
      status: 409,
      messageKey: "error.ambiguousProjectPrefix",
    });

    const disambiguatedWs2 = parseToolSuccess<ProjectResponse>(
      await admin1Client.callTool({
        name: "get_project",
        arguments: { projectRef: "APP", workspaceId: wks2 },
      }),
    );
    expect(disambiguatedWs2.project.id).toBe(ws2Proj.id);

    // Denied outbox entries from member1's MCP client have actorType="agent", channel="mcp", clientId
    const events = await db.uow.run((repos) => repos.outbox.listByWorkspace(wks1));
    const privReadDenied = events.find(
      (e) => e.eventType === "task.read.denied" && e.targetId === privTask.id,
    );
    expect(privReadDenied).toMatchObject({
      actorUserId: member1.userId,
      actorType: "agent",
      channel: "mcp",
      outcome: "denied",
    });
    expect(privReadDenied?.payload.clientId).toBe(readOnlyToken.clientId);
  });

  it("serializes concurrent idempotent retries across connections and sessions into a single task, key, and event", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const server = await startTestHttpServer(db);
    const ids = createSystemIdGenerator();
    const now = "2026-11-28T10:00:00.000Z";

    const admin = await server.signUpUser("concurrent-admin@example.com", "Concurrent Admin");
    const wksId = ids.next("wks");
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "conc-ws",
        name: "Concurrent Workspace",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: admin.userId,
        role: "admin",
        createdAt: now,
      });
    });

    await server.webJson(`/api/v1/workspaces/${wksId}/settings`, admin.jar, {
      method: "PATCH",
      json: { devProjectsEnabled: true },
    });
    const projRes = await server.webJson<{ project: ProjectDto }>(
      `/api/v1/workspaces/${wksId}/projects`,
      admin.jar,
      {
        method: "POST",
        json: { name: "Race Project", visibility: "workspace" },
      },
    );
    const projectId = projRes.data.project.id;
    await server.webJson(`/api/v1/projects/${projectId}/dev-settings/enable`, admin.jar, {
      method: "POST",
      json: { prefix: "CON" },
    });

    // 1. Concurrent application calls across 8 separate DB connections behind a start barrier
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolveBarrier) => {
      releaseBarrier = resolveBarrier;
    });
    let readyCount = 0;
    const workerClients = Array.from({ length: 8 }, () =>
      targetDb === "sqlite"
        ? ctx.openClient({
            busyTimeoutMs: 25,
            maxRetryAttempts: 60,
            retryBaseDelayMs: 5,
          })
        : ctx.openClient({ maxPoolSize: 2, maxRetryAttempts: 12 }),
    );

    const dbRacePromises = workerClients.map(async (workerDb) => {
      const work = createWorkUseCases({
        uow: workerDb.uow,
        idGenerator: createSystemIdGenerator(),
        clock: { now: () => new Date(now) },
      });
      readyCount += 1;
      if (readyCount === workerClients.length) {
        releaseBarrier();
      }
      await barrier;
      return work.createTaskByProjectRef(
        {
          userId: admin.userId,
          actorType: "agent",
          channel: "mcp",
          clientId: "race-client",
        },
        "CON",
        {
          title: "Barrier race task",
          description: "must be created once",
          idempotencyKey: "race-key-001",
        },
        { workspaceId: wksId },
      );
    });

    const raceResults = await Promise.all(dbRacePromises);
    const createdTaskIds = new Set<string>();
    const createdIssueKeys = new Set<string | null>();
    for (const r of raceResults) {
      expect(r.ok).toBe(true);
      if (r.ok) {
        createdTaskIds.add(r.data.task.id);
        createdIssueKeys.add(r.data.task.issueKey);
      }
    }
    expect(createdTaskIds.size).toBe(1);
    expect(Array.from(createdIssueKeys)).toEqual(["CON-1"]);

    // 2. Concurrent HTTP /mcp create_task calls across 5 distinct MCP sessions for a second key
    const token = await server.issueOAuthAccessToken(
      admin.jar,
      `openid profile email ${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
    );
    const mcpClients = await Promise.all(
      Array.from({ length: 5 }, () => server.connectMcpClient(token.accessToken)),
    );
    let mcpReady = 0;
    let releaseMcp!: () => void;
    const mcpBarrier = new Promise<void>((resolveMcp) => {
      releaseMcp = resolveMcp;
    });

    const mcpResults = await Promise.all(
      mcpClients.map(async (client) => {
        mcpReady += 1;
        if (mcpReady === mcpClients.length) {
          releaseMcp();
        }
        await mcpBarrier;
        return parseToolSuccess<TaskResponse>(
          await client.callTool({
            name: "create_task",
            arguments: {
              projectRef: "CON",
              title: "MCP concurrent task",
              idempotencyKey: "mcp-race-002",
            },
          }),
        );
      }),
    );

    const secondIds = new Set(mcpResults.map((r) => r.task.id));
    expect(secondIds.size).toBe(1);
    expect(mcpResults.every((r) => r.task.issueKey === "CON-2")).toBe(true);

    // 3. Sequential verification: next key MUST be CON-3 (counter never leaked/double-bumped!)
    const thirdRes = parseToolSuccess<TaskResponse>(
      await mcpClients[0]!.callTool({
        name: "create_task",
        arguments: {
          projectRef: "CON",
          title: "Sequential third task",
          idempotencyKey: "mcp-seq-003",
        },
      }),
    );
    expect(thirdRes.task.issueKey).toBe("CON-3");

    const dbCounts = await db.uow.run(async (repos) => {
      const tasks = await repos.tasks.listByProject(projectId);
      const events = await repos.outbox.listByWorkspace(wksId);
      return {
        taskCount: tasks.length,
        createdEvents: events.filter((e) => e.eventType === "task.created"),
      };
    });
    expect(dbCounts.taskCount).toBe(3);
    expect(dbCounts.createdEvents).toHaveLength(3);
    expect(
      new Set(dbCounts.createdEvents.map((e) => e.targetId)).size,
    ).toBe(3);
  });

  it("handles post-commit response loss, preserves human edits on replay, rejects conflicting payloads, and hides revoked tasks", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const server = await startTestHttpServer(db);
    const ids = createSystemIdGenerator();
    const now = "2026-11-28T10:00:00.000Z";

    const admin = await server.signUpUser("owner@example.com", "Owner");
    const member = await server.signUpUser("agent-user@example.com", "Agent User");
    const viewer = await server.signUpUser("viewer@example.com", "Viewer User");

    const wksId = ids.next("wks");
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "replay-ws",
        name: "Replay Workspace",
        createdAt: now,
      });
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
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: viewer.userId,
        role: "viewer",
        createdAt: now,
      });
    });

    await server.webJson(`/api/v1/workspaces/${wksId}/settings`, admin.jar, {
      method: "PATCH",
      json: { devProjectsEnabled: true },
    });
    const pubProj = (
      await server.webJson<{ project: ProjectDto }>(
        `/api/v1/workspaces/${wksId}/projects`,
        admin.jar,
        { method: "POST", json: { name: "Shared Board", visibility: "workspace" } },
      )
    ).data.project;
    const privProj = (
      await server.webJson<{ project: ProjectDto }>(
        `/api/v1/workspaces/${wksId}/projects`,
        admin.jar,
        { method: "POST", json: { name: "Private Board", visibility: "private" } },
      )
    ).data.project;
    await server.webJson(`/api/v1/projects/${pubProj.id}/dev-settings/enable`, admin.jar, {
      method: "POST",
      json: { prefix: "RPL" },
    });

    // 1. Post-commit response loss simulation via UoW wrapper
    let simulatedDropPending = true;
    const droppingUow: UnitOfWork = {
      async run<T>(fn: (repos: TransactionRepositories) => Promise<T>): Promise<T> {
        const result = await db.uow.run(fn);
        if (simulatedDropPending) {
          simulatedDropPending = false;
          throw new Error("Simulated network drop after commit");
        }
        return result;
      },
    };
    const droppingWork = createWorkUseCases({
      uow: droppingUow,
      idGenerator: createSystemIdGenerator(),
      clock: { now: () => new Date(now) },
    });

    await expect(
      droppingWork.createTaskByProjectRef(
        {
          userId: member.userId,
          actorType: "agent",
          channel: "mcp",
          clientId: "drop-client",
        },
        "RPL",
        {
          title: "Initial agent title",
          description: "Initial agent description",
          idempotencyKey: "drop-then-replay-1",
        },
        { workspaceId: wksId },
      ),
    ).rejects.toThrow("Simulated network drop after commit");

    // Between commit and replay: human edits title, description, assignee, status & renames RPL -> NEW
    const doneStatus = pubProj.statuses.find((s) => s.category === "done")!;
    const humanEdit = await server.webJson<TaskResponse>(
      `/api/v1/tasks/RPL-1`,
      admin.jar,
      {
        method: "PATCH",
        json: {
          title: "Human refined title",
          description: "Human edited notes",
          statusId: doneStatus.id,
          assigneeId: admin.userId,
        },
      },
    );
    expect(humanEdit.status).toBe(200);
    await server.webJson(`/api/v1/projects/${pubProj.id}/dev-settings`, admin.jar, {
      method: "PATCH",
      json: { prefix: "NEW" },
    });

    // Member retries via real MCP server using ORIGINAL projectRef "RPL", ORIGINAL title & key!
    const memberToken = await server.issueOAuthAccessToken(
      member.jar,
      `openid profile email ${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
    );
    const memberClient = await server.connectMcpClient(memberToken.accessToken);

    const replayRes = parseToolSuccess<TaskResponse>(
      await memberClient.callTool({
        name: "create_task",
        arguments: {
          projectRef: "RPL",
          title: "Initial agent title",
          description: "Initial agent description",
          idempotencyKey: "drop-then-replay-1",
        },
      }),
    );
    expect(replayRes.idempotentReplay).toBe(true);
    expect(replayRes.task.id).toBe(humanEdit.data.task.id);
    expect(replayRes.task.issueKey).toBe("NEW-1");
    expect(replayRes.task.title).toBe("Human refined title");
    expect(replayRes.task.description).toBe("Human edited notes");
    expect(replayRes.task.statusId).toBe(doneStatus.id);
    expect(replayRes.task.assigneeId).toBe(admin.userId);

    // 2. Different payload with same idempotencyKey -> 409 CONFLICT without leaking original task
    const conflictErr = parseToolError(
      await memberClient.callTool({
        name: "create_task",
        arguments: {
          projectRef: "NEW",
          title: "Different title",
          description: "Initial agent description",
          idempotencyKey: "drop-then-replay-1",
        },
      }),
    );
    expect(conflictErr.error).toEqual({
      code: "CONFLICT",
      status: 409,
      messageKey: "error.idempotencyConflict",
    });

    // Different user CAN reuse the same idempotencyKey string independently
    const adminToken = await server.issueOAuthAccessToken(
      admin.jar,
      `openid profile email ${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
    );
    const adminClient = await server.connectMcpClient(adminToken.accessToken);
    const adminOwnTask = parseToolSuccess<TaskResponse>(
      await adminClient.callTool({
        name: "create_task",
        arguments: {
          projectRef: "NEW",
          title: "Admin independent task",
          idempotencyKey: "drop-then-replay-1",
        },
      }),
    );
    expect(adminOwnTask.task.id).not.toBe(replayRes.task.id);
    expect(adminOwnTask.task.issueKey).toBe("NEW-2");

    // 3. Subtask creation via parentTaskRef key ("NEW-1") and replay via parentTaskRef public ID (tsk_*)
    const subCreate = parseToolSuccess<TaskResponse>(
      await memberClient.callTool({
        name: "create_task",
        arguments: {
          projectRef: "NEW",
          title: "Subtask from key",
          parentTaskRef: "NEW-1",
          idempotencyKey: "subtask-key-ref-1",
        },
      }),
    );
    expect(subCreate.idempotentReplay).toBe(false);
    expect(subCreate.task.parentTaskId).toBe(replayRes.task.id);
    expect(subCreate.task.issueKey).toBe("NEW-3");

    const subReplayById = parseToolSuccess<TaskResponse>(
      await memberClient.callTool({
        name: "create_task",
        arguments: {
          projectRef: pubProj.id,
          title: "Subtask from key",
          parentTaskRef: replayRes.task.id,
          idempotencyKey: "subtask-key-ref-1",
        },
      }),
    );
    expect(subReplayById.idempotentReplay).toBe(true);
    expect(subReplayById.task.id).toBe(subCreate.task.id);

    // Move parent + inherited subtask to another readable project, then replay original subtask create_task
    const secondReadableProj = (
      await server.webJson<{ project: ProjectDto }>(
        `/api/v1/workspaces/${wksId}/projects`,
        admin.jar,
        { method: "POST", json: { name: "Secondary Readable Board", visibility: "workspace" } },
      )
    ).data.project;
    const moveParentRes = await server.webJson<TaskResponse>(
      `/api/v1/tasks/${replayRes.task.id}/move`,
      admin.jar,
      { method: "POST", json: { projectId: secondReadableProj.id } },
    );
    expect(moveParentRes.status).toBe(200);

    const subReplayAfterParentMove = parseToolSuccess<TaskResponse>(
      await memberClient.callTool({
        name: "create_task",
        arguments: {
          projectRef: "NEW",
          title: "Subtask from key",
          parentTaskRef: "NEW-1",
          idempotencyKey: "subtask-key-ref-1",
        },
      }),
    );
    expect(subReplayAfterParentMove.idempotentReplay).toBe(true);
    expect(subReplayAfterParentMove.task.id).toBe(subCreate.task.id);
    expect(subReplayAfterParentMove.task.effectiveProjectId).toBe(
      secondReadableProj.id,
    );

    // Move parent back to pubProj so subsequent tests operate against pubProj/privProj as expected
    expect(
      (
        await server.webJson<TaskResponse>(
          `/api/v1/tasks/${replayRes.task.id}/move`,
          admin.jar,
          { method: "POST", json: { projectId: pubProj.id } },
        )
      ).status,
    ).toBe(200);

    // Calling create_task against an unreadable private project using an unrelated project's idempotencyKey
    // must record task.create.denied against privProj (not task.read.denied against the unrelated task)
    const crossProjDenied = parseToolError(
      await memberClient.callTool({
        name: "create_task",
        arguments: {
          projectRef: privProj.id,
          title: "Cross project probe",
          idempotencyKey: "subtask-key-ref-1",
        },
      }),
    );
    expect(crossProjDenied.error.status).toBe(404);

    // 4. Optional HTTP Idempotency-Key header returns 201 on first call and 200 on replay
    const httpFirst = await server.webJson<TaskResponse>(
      `/api/v1/projects/${pubProj.id}/tasks`,
      admin.jar,
      {
        method: "POST",
        headers: { "idempotency-key": "http-hdr-1" },
        json: { title: "HTTP idempotent task" },
      },
    );
    expect(httpFirst.status).toBe(201);
    const httpSecond = await server.webJson<TaskResponse>(
      `/api/v1/projects/${pubProj.id}/tasks`,
      admin.jar,
      {
        method: "POST",
        headers: { "idempotency-key": "http-hdr-1" },
        json: { title: "HTTP idempotent task" },
      },
    );
    expect(httpSecond.status).toBe(200);
    expect(httpSecond.data.task.id).toBe(httpFirst.data.task.id);
    expect(httpSecond.data.idempotentReplay).toBe(true);

    // 5. Access revocation tests:
    // (a) Admin moves RPL-1/NEW-1 into unreadable private project -> member replay returns 404 & leaks nothing
    const moveRes = await server.webJson<TaskResponse>(
      `/api/v1/tasks/${replayRes.task.id}/move`,
      admin.jar,
      {
        method: "POST",
        json: { projectId: privProj.id },
      },
    );
    expect(moveRes.status).toBe(200);

    const movedCallRaw = await memberClient.callTool({
      name: "create_task",
      arguments: {
        projectRef: "RPL",
        title: "Initial agent title",
        description: "Initial agent description",
        idempotencyKey: "drop-then-replay-1",
      },
    });
    const movedText = readToolText(movedCallRaw);
    expect(parseToolError(movedCallRaw).error.status).toBe(404);
    expect(movedText).not.toContain(replayRes.task.id);
    expect(movedText).not.toContain("Human refined title");
    expect(movedText).not.toContain("NEW-1");

    // (b) Member added to private project, creates task, then removed -> replay hides existence (404)
    await db.uow.run((repos) =>
      repos.projects.upsertMembership({
        id: ids.next("mbr"),
        projectId: privProj.id,
        userId: member.userId,
        role: "member",
        createdAt: now,
      }),
    );
    const privCreated = parseToolSuccess<TaskResponse>(
      await memberClient.callTool({
        name: "create_task",
        arguments: {
          projectRef: privProj.id,
          title: "Private secret item",
          idempotencyKey: "priv-revoke-1",
        },
      }),
    );
    expect(privCreated.task.title).toBe("Private secret item");

    await db.uow.run((repos) =>
      repos.projects.deleteMembership(privProj.id, member.userId),
    );
    const privRevokedRaw = await memberClient.callTool({
      name: "create_task",
      arguments: {
        projectRef: privProj.id,
        title: "Private secret item",
        idempotencyKey: "priv-revoke-1",
      },
    });
    const privRevokedText = readToolText(privRevokedRaw);
    expect(parseToolError(privRevokedRaw).error.status).toBe(404);
    expect(privRevokedText).not.toContain(privCreated.task.id);
    expect(privRevokedText).not.toContain("Private secret item");

    // 6. Viewer with prood:write scope cannot create tasks via MCP (403 + outbox denied)
    const viewerToken = await server.issueOAuthAccessToken(
      viewer.jar,
      `openid profile email ${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
    );
    const viewerClient = await server.connectMcpClient(viewerToken.accessToken);
    const viewerErr = parseToolError(
      await viewerClient.callTool({
        name: "create_task",
        arguments: {
          projectRef: "NEW",
          title: "Viewer forbidden create",
          idempotencyKey: "viewer-denied-1",
        },
      }),
    );
    expect(viewerErr.error).toEqual({
      code: "FORBIDDEN",
      status: 403,
      messageKey: "error.forbidden",
    });

    const outbox = await db.uow.run((repos) => repos.outbox.listByWorkspace(wksId));
    expect(
      outbox.some(
        (e) =>
          e.eventType === "task.create.denied" &&
          e.actorUserId === viewer.userId &&
          e.channel === "mcp" &&
          e.actorType === "agent",
      ),
    ).toBe(true);
    expect(
      outbox.some(
        (e) =>
          e.eventType === "task.read.denied" &&
          e.actorUserId === member.userId &&
          e.targetId === replayRes.task.id &&
          e.channel === "mcp",
      ),
    ).toBe(true);
    expect(
      outbox.some(
        (e) =>
          e.eventType === "task.create.denied" &&
          e.actorUserId === member.userId &&
          e.targetType === "project" &&
          e.targetId === privProj.id &&
          e.channel === "mcp",
      ),
    ).toBe(true);
    expect(
      outbox.some(
        (e) =>
          e.eventType === "task.read.denied" &&
          e.projectId === privProj.id &&
          e.targetId === subCreate.task.id,
      ),
    ).toBe(false);

    // Header mismatch on HTTP POST returns 400 validation error
    const headerMismatch = await server.webJson<ApiErrorResponse>(
      `/api/v1/projects/${pubProj.id}/tasks`,
      admin.jar,
      {
        method: "POST",
        headers: { "idempotency-key": "http-hdr-a" },
        json: { title: "Mismatch", idempotencyKey: "http-hdr-b" },
      },
    );
    expect(headerMismatch.status).toBe(400);
  });
});
