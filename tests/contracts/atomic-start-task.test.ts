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
} from "@prood/application";
import {
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
  type DbDriverKind,
  type DeleteProjectStatusResponse,
  type McpToolErrorPayload,
  type MeResponse,
  type ProjectDto,
  type ProjectResponse,
  type ProjectStatusResponse,
  type StartTaskResponse,
  type TaskResponse,
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

const AUTH_SECRET = "prood-pr11-atomic-start-secret-at-least-32-chars";

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
    const dir = mkdtempSync(join(tmpdir(), "prood-pr11-sqlite-"));
    const filePath = join(dir, "pr11.sqlite");
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

  const schema = `prood_pr11_${Date.now().toString(36)}_${Math.random()
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

function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) {
      release();
    }
    await gate;
  };
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
        password: "mcp-pr11-password-123",
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
        client_name: "Prood PR11 Test Client",
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
    const client = new Client({ name: "prood-pr11-client", version: "1.0.0" });
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

describe(`Atomic start_task & status transition contracts (${targetDb})`, () => {
  it("elects a single winner across concurrent two-user starts, keeps loser zero-change, and makes same-actor retries idempotent", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const server = await startTestHttpServer(db);
    const ids = createSystemIdGenerator();
    const now = "2026-11-28T10:00:00.000Z";

    const admin = await server.signUpUser("admin-start@example.com", "Admin");
    const memberA = await server.signUpUser("member-a@example.com", "Member A");
    const memberB = await server.signUpUser("member-b@example.com", "Member B");

    const wksId = ids.next("wks");
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "start-race-ws",
        name: "Start Race Workspace",
        createdAt: now,
      });
      for (const [userId, role] of [
        [admin.userId, "admin"],
        [memberA.userId, "member"],
        [memberB.userId, "member"],
      ] as const) {
        await repos.memberships.create({
          id: ids.next("mbr"),
          workspaceId: wksId,
          userId,
          role,
          createdAt: now,
        });
      }
    });

    await server.webJson(`/api/v1/workspaces/${wksId}/settings`, admin.jar, {
      method: "PATCH",
      json: { devProjectsEnabled: true },
    });
    const proj = (
      await server.webJson<{ project: ProjectDto }>(
        `/api/v1/workspaces/${wksId}/projects`,
        admin.jar,
        { method: "POST", json: { name: "Atomic Dev", visibility: "workspace" } },
      )
    ).data.project;
    const inProgressStatus = proj.statuses.find(
      (s) => s.category === "in_progress",
    )!;
    await server.webJson(`/api/v1/projects/${proj.id}/dev-settings/enable`, admin.jar, {
      method: "POST",
      json: { prefix: "ATM", startStatusId: inProgressStatus.id },
    });

    const t1 = (
      await server.webJson<TaskResponse>(
        `/api/v1/projects/${proj.id}/tasks`,
        admin.jar,
        { method: "POST", json: { title: "DB race target" } },
      )
    ).data.task;
    const t2 = (
      await server.webJson<TaskResponse>(
        `/api/v1/projects/${proj.id}/tasks`,
        admin.jar,
        { method: "POST", json: { title: "MCP race target" } },
      )
    ).data.task;

    // 1. Two independent DB connections racing to start ATM-1
    const makeWorkerDb = () =>
      targetDb === "sqlite"
        ? ctx.openClient({
            busyTimeoutMs: 25,
            maxRetryAttempts: 60,
            retryBaseDelayMs: 5,
          })
        : ctx.openClient({ maxPoolSize: 2, maxRetryAttempts: 12 });

    const workA = createWorkUseCases({
      uow: makeWorkerDb().uow,
      idGenerator: createSystemIdGenerator(),
      clock: { now: () => new Date() },
    });
    const workB = createWorkUseCases({
      uow: makeWorkerDb().uow,
      idGenerator: createSystemIdGenerator(),
      clock: { now: () => new Date() },
    });

    const dbBarrier = createBarrier(2);
    const [resA, resB] = await Promise.all([
      (async () => {
        await dbBarrier();
        return workA.startTask(
          { userId: memberA.userId, actorType: "agent", channel: "mcp", clientId: "cli-a" },
          "ATM-1",
          {},
          { workspaceId: wksId },
        );
      })(),
      (async () => {
        await dbBarrier();
        return workB.startTask(
          { userId: memberB.userId, actorType: "agent", channel: "mcp", clientId: "cli-b" },
          t1.id,
          {},
        );
      })(),
    ]);

    const outcomes = [
      { userId: memberA.userId, res: resA },
      { userId: memberB.userId, res: resB },
    ];
    const winners = outcomes.filter((o) => o.res.ok);
    const losers = outcomes.filter((o) => !o.res.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winner = winners[0]!;
    const loser = losers[0]!;
    if (winner.res.ok) {
      expect(winner.res.data.changed).toBe(true);
      expect(winner.res.data.task.assigneeId).toBe(winner.userId);
      expect(winner.res.data.task.statusId).toBe(inProgressStatus.id);
      expect(winner.res.data.branchName).toBe("atm-1");
    }
    if (!loser.res.ok) {
      expect(loser.res.status).toBe(409);
      expect(loser.res.code).toBe("CONFLICT");
      expect(loser.res.messageKey).toBe("error.taskAlreadyAssigned");
    }

    // 2. Concurrent MCP sessions for ATM-2 (memberA vs memberB)
    const tokenA = await server.issueOAuthAccessToken(
      memberA.jar,
      `openid profile email ${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
    );
    const tokenB = await server.issueOAuthAccessToken(
      memberB.jar,
      `openid profile email ${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
    );
    const mcpA = await server.connectMcpClient(tokenA.accessToken);
    const mcpB = await server.connectMcpClient(tokenB.accessToken);
    const mcpBarrier = createBarrier(2);

    const [rawA, rawB] = await Promise.all([
      (async () => {
        await mcpBarrier();
        return mcpA.callTool({
          name: "start_task",
          arguments: { taskRef: "ATM-2" },
        });
      })(),
      (async () => {
        await mcpBarrier();
        return mcpB.callTool({
          name: "start_task",
          arguments: { taskRef: t2.id },
        });
      })(),
    ]);

    const mcpWinners = [
      { userId: memberA.userId, client: mcpA, raw: rawA, clientId: tokenA.clientId },
      { userId: memberB.userId, client: mcpB, raw: rawB, clientId: tokenB.clientId },
    ].filter((x) => !(x.raw as { isError?: unknown }).isError);
    const mcpLosers = [
      { userId: memberA.userId, client: mcpA, raw: rawA },
      { userId: memberB.userId, client: mcpB, raw: rawB },
    ].filter((x) => (x.raw as { isError?: unknown }).isError === true);
    expect(mcpWinners).toHaveLength(1);
    expect(mcpLosers).toHaveLength(1);

    const mcpWinnerData = parseToolSuccess<StartTaskResponse>(mcpWinners[0]!.raw);
    const mcpLoserErr = parseToolError(mcpLosers[0]!.raw);
    expect(mcpWinnerData.changed).toBe(true);
    expect(mcpWinnerData.branchName).toBe("atm-2");
    expect(mcpWinnerData.task.assigneeId).toBe(mcpWinners[0]!.userId);
    expect(mcpLoserErr.error).toEqual({
      code: "CONFLICT",
      status: 409,
      messageKey: "error.taskAlreadyAssigned",
    });

    // 3. Same-actor concurrent retries (6-way DB barrier) on ATM-3 -> only 1 task.started event!
    const t3 = (
      await server.webJson<TaskResponse>(
        `/api/v1/projects/${proj.id}/tasks`,
        admin.jar,
        { method: "POST", json: { title: "Retry dedupe target" } },
      )
    ).data.task;
    const retryWorkers = Array.from({ length: 6 }, () =>
      createWorkUseCases({
        uow: makeWorkerDb().uow,
        idGenerator: createSystemIdGenerator(),
        clock: { now: () => new Date() },
      }),
    );
    const retryBarrier = createBarrier(6);
    const retryResults = await Promise.all(
      retryWorkers.map(async (w) => {
        await retryBarrier();
        return w.startTask(
          { userId: memberA.userId, actorType: "agent", channel: "mcp", clientId: "retry-cli" },
          "ATM-3",
        );
      }),
    );
    for (const r of retryResults) {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.task.id).toBe(t3.id);
        expect(r.data.task.assigneeId).toBe(memberA.userId);
        expect(r.data.branchName).toBe("atm-3");
      }
    }
    const seqRetry = parseToolSuccess<StartTaskResponse>(
      await mcpA.callTool({
        name: "start_task",
        arguments: { taskRef: "ATM-3" },
      }),
    );
    expect(seqRetry.changed).toBe(false);

    // Check DB & outbox invariants
    const audit = await db.uow.run(async (repos) => {
      const events = await repos.outbox.listByWorkspace(wksId);
      const t1Row = await repos.tasks.findById(t1.id);
      const t2Row = await repos.tasks.findById(t2.id);
      return { events, t1Row, t2Row };
    });

    expect(audit.t1Row?.assigneeId).toBe(winner.userId);
    expect(audit.t2Row?.assigneeId).toBe(mcpWinners[0]!.userId);

    for (const taskId of [t1.id, t2.id, t3.id]) {
      const started = audit.events.filter(
        (e) => e.eventType === "task.started" && e.targetId === taskId,
      );
      expect(started).toHaveLength(1);
    }

    const t2Started = audit.events.find(
      (e) => e.eventType === "task.started" && e.targetId === t2.id,
    );
    expect(t2Started).toMatchObject({
      actorUserId: mcpWinners[0]!.userId,
      actorType: "agent",
      channel: "mcp",
      outcome: "succeeded",
    });
    expect(t2Started?.payload.clientId).toBe(mcpWinners[0]!.clientId);
    expect(t2Started?.payload.branchName).toBe("atm-2");

    const t2Denied = audit.events.find(
      (e) =>
        e.eventType === "task.start.denied" &&
        e.targetId === t2.id &&
        e.reasonCode === "ALREADY_ASSIGNED",
    );
    expect(t2Denied).toBeTruthy();
  });

  it("prevents status regression, gates completed tasks behind explicit reopen, and keeps branchName fixed after rename and workspace setting disable", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const server = await startTestHttpServer(db);
    const ids = createSystemIdGenerator();
    const now = "2026-11-28T10:00:00.000Z";

    const admin = await server.signUpUser("admin-flow@example.com", "Admin Flow");
    const member = await server.signUpUser("member-flow@example.com", "Member Flow");
    const other = await server.signUpUser("other-flow@example.com", "Other Flow");

    const wksId = ids.next("wks");
    const inReviewId = ids.next("sts");
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "flow-ws",
        name: "Flow Workspace",
        createdAt: now,
      });
      for (const [userId, role] of [
        [admin.userId, "admin"],
        [member.userId, "member"],
        [other.userId, "member"],
      ] as const) {
        await repos.memberships.create({
          id: ids.next("mbr"),
          workspaceId: wksId,
          userId,
          role,
          createdAt: now,
        });
      }
    });

    await server.webJson(`/api/v1/workspaces/${wksId}/settings`, admin.jar, {
      method: "PATCH",
      json: { devProjectsEnabled: true },
    });
    const proj = (
      await server.webJson<{ project: ProjectDto }>(
        `/api/v1/workspaces/${wksId}/projects`,
        admin.jar,
        { method: "POST", json: { name: "Flow Dev", visibility: "workspace" } },
      )
    ).data.project;

    const inProgress = proj.statuses.find((s) => s.category === "in_progress")!;
    const done = proj.statuses.find((s) => s.category === "done")!;
    // Add an advanced in_progress status at higher position than In Progress
    await db.uow.run((repos) =>
      repos.statuses.create({
        id: inReviewId,
        workspaceId: wksId,
        projectId: proj.id,
        name: "In Review",
        category: "in_progress",
        position: 5,
        createdAt: now,
      }),
    );

    await server.webJson(`/api/v1/projects/${proj.id}/dev-settings/enable`, admin.jar, {
      method: "POST",
      json: { prefix: "PRD", startStatusId: inProgress.id },
    });

    const advancedTask = (
      await server.webJson<TaskResponse>(
        `/api/v1/projects/${proj.id}/tasks`,
        admin.jar,
        { method: "POST", json: { title: "Advanced status item", statusId: inReviewId } },
      )
    ).data.task;
    expect(advancedTask.issueKey).toBe("PRD-1");

    const doneTask = (
      await server.webJson<TaskResponse>(
        `/api/v1/projects/${proj.id}/tasks`,
        admin.jar,
        { method: "POST", json: { title: "Completed item", statusId: done.id } },
      )
    ).data.task;
    await server.webJson(`/api/v1/tasks/${doneTask.id}`, member.jar, {
      method: "PATCH",
      json: {
        assigneeId: member.userId,
        completedAt: "2026-11-28T09:30:00.000Z",
      },
    });

    // Rename PRD -> APP AND disable devProjectsEnabled in workspace settings (Stage 1 exit criterion!)
    await server.webJson(`/api/v1/projects/${proj.id}/dev-settings`, admin.jar, {
      method: "PATCH",
      json: { prefix: "APP" },
    });
    await server.webJson(`/api/v1/workspaces/${wksId}/settings`, admin.jar, {
      method: "PATCH",
      json: { devProjectsEnabled: false },
    });

    const memberToken = await server.issueOAuthAccessToken(
      member.jar,
      `openid profile email ${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
    );
    const otherToken = await server.issueOAuthAccessToken(
      other.jar,
      `openid profile email ${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
    );
    const memberMcp = await server.connectMcpClient(memberToken.accessToken);
    const otherMcp = await server.connectMcpClient(otherToken.accessToken);

    // 1. Verify old key PRD-1 works across Web GET, MCP get_task, and MCP start_task even after devProjectsEnabled=false!
    const webReadOldKey = await server.webJson<TaskResponse>("/api/v1/tasks/PRD-1", member.jar);
    expect(webReadOldKey.status).toBe(200);
    expect(webReadOldKey.data.task.issueKey).toBe("APP-1");

    const mcpReadOldKey = parseToolSuccess<TaskResponse>(
      await memberMcp.callTool({ name: "get_task", arguments: { taskRef: "PRD-1" } }),
    );
    expect(mcpReadOldKey.task.id).toBe(advancedTask.id);

    const startAdvanced = parseToolSuccess<StartTaskResponse>(
      await memberMcp.callTool({ name: "start_task", arguments: { taskRef: "PRD-1" } }),
    );
    expect(startAdvanced.changed).toBe(true);
    expect(startAdvanced.task.id).toBe(advancedTask.id);
    expect(startAdvanced.task.assigneeId).toBe(member.userId);
    // Must NOT regress from In Review back to In Progress
    expect(startAdvanced.task.statusId).toBe(inReviewId);
    // Branch name MUST stay fixed at original lowercase prefix `prd-1`, while issueKey is `APP-1`
    expect(startAdvanced.task.issueKey).toBe("APP-1");
    expect(startAdvanced.branchName).toBe("prd-1");
    expect(startAdvanced.task.branchName).toBe("prd-1");

    // 2. Completed task without reopen=true fails 409 and changes nothing
    const blockedDone = parseToolError(
      await memberMcp.callTool({ name: "start_task", arguments: { taskRef: "APP-2" } }),
    );
    expect(blockedDone.error).toEqual({
      code: "CONFLICT",
      status: 409,
      messageKey: "error.taskCompletedReopenRequired",
    });
    const stillDone = await server.webJson<TaskResponse>("/api/v1/tasks/APP-2", member.jar);
    expect(stillDone.data.task.statusId).toBe(done.id);
    expect(stillDone.data.task.completedAt).toBe("2026-11-28T09:30:00.000Z");

    // 3. Another user trying reopen=true on assigned completed task still fails ALREADY_ASSIGNED
    const hijackDone = parseToolError(
      await otherMcp.callTool({
        name: "start_task",
        arguments: { taskRef: "APP-2", reopen: true },
      }),
    );
    expect(hijackDone.error).toEqual({
      code: "CONFLICT",
      status: 409,
      messageKey: "error.taskAlreadyAssigned",
    });

    // 4. Assignee explicitly reopens completed task -> clears completedAt & moves to inProgress
    const reopened = parseToolSuccess<StartTaskResponse>(
      await memberMcp.callTool({
        name: "start_task",
        arguments: { taskRef: "APP-2", reopen: true },
      }),
    );
    expect(reopened.changed).toBe(true);
    expect(reopened.task.statusId).toBe(inProgress.id);
    expect(reopened.task.completedAt).toBeNull();
    expect(reopened.branchName).toBe("prd-2");
  });

  it("serializes concurrent status rename and status delete with start_task without invalid statuses or FK errors", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const server = await startTestHttpServer(db);
    const ids = createSystemIdGenerator();
    const now = "2026-11-28T10:00:00.000Z";

    const admin = await server.signUpUser("admin-sts@example.com", "Admin Sts");
    const member = await server.signUpUser("member-sts@example.com", "Member Sts");
    const wksId = ids.next("wks");
    const customStartId = ids.next("sts");

    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "status-race-ws",
        name: "Status Race WS",
        createdAt: now,
      });
      for (const [userId, role] of [
        [admin.userId, "admin"],
        [member.userId, "member"],
      ] as const) {
        await repos.memberships.create({
          id: ids.next("mbr"),
          workspaceId: wksId,
          userId,
          role,
          createdAt: now,
        });
      }
    });

    await server.webJson(`/api/v1/workspaces/${wksId}/settings`, admin.jar, {
      method: "PATCH",
      json: { devProjectsEnabled: true },
    });
    const proj = (
      await server.webJson<{ project: ProjectDto }>(
        `/api/v1/workspaces/${wksId}/projects`,
        admin.jar,
        { method: "POST", json: { name: "Status Race", visibility: "workspace" } },
      )
    ).data.project;

    const customStart = (
      await db.uow.run((repos) =>
        repos.statuses.create({
          id: customStartId,
          workspaceId: wksId,
          projectId: proj.id,
          name: "Ready to Code",
          category: "in_progress",
          position: 10,
          createdAt: now,
        }),
      )
    );
    await server.webJson(`/api/v1/projects/${proj.id}/dev-settings/enable`, admin.jar, {
      method: "POST",
      json: { prefix: "STS", startStatusId: customStart.id },
    });

    const makeWorkerWork = () => {
      const client =
        targetDb === "sqlite"
          ? ctx.openClient({
              busyTimeoutMs: 25,
              maxRetryAttempts: 60,
              retryBaseDelayMs: 5,
            })
          : ctx.openClient({ maxPoolSize: 2, maxRetryAttempts: 12 });
      return createWorkUseCases({
        uow: client.uow,
        idGenerator: createSystemIdGenerator(),
        clock: { now: () => new Date() },
      });
    };

    // 1. Concurrent status rename vs start_task
    const renameTask = (
      await server.webJson<TaskResponse>(
        `/api/v1/projects/${proj.id}/tasks`,
        admin.jar,
        { method: "POST", json: { title: "Rename race task" } },
      )
    ).data.task;
    const renameBarrier = createBarrier(2);
    const renameAdminWork = makeWorkerWork();
    const renameMemberWork = makeWorkerWork();

    const [renameRes, startRenameRes] = await Promise.all([
      (async () => {
        await renameBarrier();
        return renameAdminWork.updateProjectStatus(
          { userId: admin.userId, actorType: "user", channel: "web" },
          proj.id,
          customStart.id,
          { name: "Actively Coding" },
        );
      })(),
      (async () => {
        await renameBarrier();
        return renameMemberWork.startTask(
          { userId: member.userId, actorType: "agent", channel: "mcp", clientId: "sts-cli" },
          "STS-1",
        );
      })(),
    ]);
    expect(renameRes.ok).toBe(true);
    expect(startRenameRes.ok).toBe(true);
    if (startRenameRes.ok) {
      expect(startRenameRes.data.task.id).toBe(renameTask.id);
      expect(startRenameRes.data.task.statusId).toBe(customStart.id);
    }

    // 2. Concurrent status delete vs start_task
    const deleteTask = (
      await server.webJson<TaskResponse>(
        `/api/v1/projects/${proj.id}/tasks`,
        admin.jar,
        { method: "POST", json: { title: "Delete race task" } },
      )
    ).data.task;
    const deleteBarrier = createBarrier(2);
    const deleteAdminWork = makeWorkerWork();
    const deleteMemberWork = makeWorkerWork();

    const [delRes, startDelRes] = await Promise.all([
      (async () => {
        await deleteBarrier();
        return deleteAdminWork.deleteProjectStatus(
          { userId: admin.userId, actorType: "user", channel: "web" },
          proj.id,
          customStart.id,
        );
      })(),
      (async () => {
        await deleteBarrier();
        return deleteMemberWork.startTask(
          { userId: member.userId, actorType: "agent", channel: "mcp", clientId: "sts-cli" },
          "STS-2",
        );
      })(),
    ]);
    expect(delRes.ok).toBe(true);
    expect(startDelRes.ok).toBe(true);

    // Verify all persisted rows remain valid after both commit
    const state = await db.uow.run(async (repos) => {
      const remainingStatuses = await repos.statuses.listByProject(proj.id);
      const validIds = new Set(remainingStatuses.map((s) => s.id));
      const t1After = await repos.tasks.findById(renameTask.id);
      const t2After = await repos.tasks.findById(deleteTask.id);
      const ns = await repos.issueKeys.findNamespaceByProjectId(proj.id);
      return { validIds, t1After, t2After, ns };
    });

    expect(state.validIds.has(customStart.id)).toBe(false);
    expect(state.ns?.startStatusId).not.toBe(customStart.id);
    for (const taskRow of [state.t1After, state.t2After]) {
      expect(taskRow?.assigneeId).toBe(member.userId);
      if (taskRow?.statusId !== null) {
        expect(state.validIds.has(taskRow!.statusId!)).toBe(true);
      }
    }

    // Also verify HTTP status rename/delete endpoints directly on a remaining status
    const todoStatus = proj.statuses.find((s) => s.category === "todo")!;
    const httpRename = await server.webJson<ProjectStatusResponse>(
      `/api/v1/projects/${proj.id}/statuses/${todoStatus.id}`,
      admin.jar,
      { method: "PATCH", json: { name: "Backlog" } },
    );
    expect(httpRename.status).toBe(200);
    expect(httpRename.data.status.name).toBe("Backlog");

    const httpDelete = await server.webJson<DeleteProjectStatusResponse>(
      `/api/v1/projects/${proj.id}/statuses/${todoStatus.id}`,
      admin.jar,
      { method: "DELETE" },
    );
    expect(httpDelete.status).toBe(200);
    expect(httpDelete.data.deletedStatusId).toBe(todoStatus.id);

    if (ctx.sqliteFilePath) {
      const raw = await openSqliteConnection(ctx.sqliteFilePath);
      try {
        expect(raw.pragma("foreign_key_check")).toEqual([]);
      } finally {
        raw.close();
      }
    }
  });

  it("supports Web HTTP start, general projects, inherited subtasks, and enforces permissions across channels", async () => {
    const ctx = await createIsolatedDb();
    const db = ctx.openClient();
    await db.migrate();
    const server = await startTestHttpServer(db);
    const ids = createSystemIdGenerator();
    const now = "2026-11-28T10:00:00.000Z";

    const admin = await server.signUpUser("auth-admin@example.com", "Auth Admin");
    const member = await server.signUpUser("auth-member@example.com", "Auth Member");
    const viewer = await server.signUpUser("auth-viewer@example.com", "Auth Viewer");
    const wksId = ids.next("wks");

    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "auth-start-ws",
        name: "Auth Start WS",
        createdAt: now,
      });
      for (const [userId, role] of [
        [admin.userId, "admin"],
        [member.userId, "member"],
        [viewer.userId, "viewer"],
      ] as const) {
        await repos.memberships.create({
          id: ids.next("mbr"),
          workspaceId: wksId,
          userId,
          role,
          createdAt: now,
        });
      }
    });

    await server.webJson(`/api/v1/workspaces/${wksId}/settings`, admin.jar, {
      method: "PATCH",
      json: { devProjectsEnabled: true },
    });

    const genProj = (
      await server.webJson<{ project: ProjectDto }>(
        `/api/v1/workspaces/${wksId}/projects`,
        admin.jar,
        { method: "POST", json: { name: "General Work", visibility: "workspace" } },
      )
    ).data.project;
    const privProj = (
      await server.webJson<{ project: ProjectDto }>(
        `/api/v1/workspaces/${wksId}/projects`,
        admin.jar,
        { method: "POST", json: { name: "Private Work", visibility: "private" } },
      )
    ).data.project;
    await server.webJson(`/api/v1/projects/${privProj.id}/dev-settings/enable`, admin.jar, {
      method: "POST",
      json: { prefix: "SEC" },
    });

    const genTask = (
      await server.webJson<TaskResponse>(
        `/api/v1/projects/${genProj.id}/tasks`,
        admin.jar,
        { method: "POST", json: { title: "General start target" } },
      )
    ).data.task;
    const privParent = (
      await server.webJson<TaskResponse>(
        `/api/v1/projects/${privProj.id}/tasks`,
        admin.jar,
        { method: "POST", json: { title: "Private parent" } },
      )
    ).data.task;
    const privSub = (
      await server.webJson<TaskResponse>(
        `/api/v1/projects/${privProj.id}/tasks`,
        admin.jar,
        {
          method: "POST",
          json: {
            title: "Private inherited subtask",
            parentTaskId: privParent.id,
            inheritParentProject: true,
          },
        },
      )
    ).data.task;

    // 1. General project task starts via Web HTTP (empty body allowed) & returns branchName: null
    const webStartGen = await server.webJson<StartTaskResponse>(
      `/api/v1/tasks/${genTask.id}/start`,
      member.jar,
      { method: "POST" },
    );
    expect(webStartGen.status).toBe(200);
    expect(webStartGen.data.changed).toBe(true);
    expect(webStartGen.data.branchName).toBeNull();
    expect(webStartGen.data.task.assigneeId).toBe(member.userId);
    expect(webStartGen.data.task.statusId).toBe(
      genProj.statuses.find((s) => s.category === "in_progress")!.id,
    );

    // 2. MCP tokens: read-only rejected on start_task; viewer rejected 403; non-member hidden 404
    const readOnlyToken = await server.issueOAuthAccessToken(
      member.jar,
      `openid profile email ${MCP_READ_SCOPE}`,
    );
    const readOnlyClient = await server.connectMcpClient(readOnlyToken.accessToken);
    await expect(
      readOnlyClient.callTool({ name: "start_task", arguments: { taskRef: genTask.id } }),
    ).rejects.toThrow();

    const memberWriteToken = await server.issueOAuthAccessToken(
      member.jar,
      `openid profile email ${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
    );
    const memberMcp = await server.connectMcpClient(memberWriteToken.accessToken);
    const hiddenSubErr = parseToolError(
      await memberMcp.callTool({ name: "start_task", arguments: { taskRef: "SEC-2" } }),
    );
    expect(hiddenSubErr.error.status).toBe(404);

    // Admin adds member to privProj -> member can now start inherited subtask SEC-2 via MCP!
    await db.uow.run((repos) =>
      repos.projects.upsertMembership({
        id: ids.next("mbr"),
        projectId: privProj.id,
        userId: member.userId,
        role: "member",
        createdAt: now,
      }),
    );
    const privProjectView = (
      await server.webJson<ProjectResponse>(
        `/api/v1/workspaces/${wksId}/projects/${privProj.id}`,
        member.jar,
      )
    ).data.project;
    expect(privProjectView.id).toBe(privProj.id);

    const startedSub = parseToolSuccess<StartTaskResponse>(
      await memberMcp.callTool({ name: "start_task", arguments: { taskRef: "SEC-2" } }),
    );
    expect(startedSub.changed).toBe(true);
    expect(startedSub.task.id).toBe(privSub.id);
    expect(startedSub.task.projectId).toBeNull();
    expect(startedSub.branchName).toBe("sec-2");
    expect(startedSub.task.assigneeId).toBe(member.userId);

    // Viewer cannot start genTask via MCP (403)
    const viewerToken = await server.issueOAuthAccessToken(
      viewer.jar,
      `openid profile email ${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
    );
    const viewerMcp = await server.connectMcpClient(viewerToken.accessToken);
    const viewerErr = parseToolError(
      await viewerMcp.callTool({ name: "start_task", arguments: { taskRef: genTask.id } }),
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
          e.eventType === "task.start.denied" &&
          e.actorUserId === viewer.userId &&
          e.channel === "mcp",
      ),
    ).toBe(true);
    expect(
      outbox.some(
        (e) =>
          e.eventType === "task.started" &&
          e.targetId === genTask.id &&
          e.channel === "web" &&
          e.actorType === "user",
      ),
    ).toBe(true);
  });
});
