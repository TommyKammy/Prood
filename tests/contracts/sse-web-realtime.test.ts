import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRealtimeHub,
  createRealtimeUseCases,
  createSystemIdGenerator,
  createWorkUseCases,
} from "@prood/application";
import {
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
  type ApiErrorResponse,
  type DbDriverKind,
  type MeResponse,
  type ProjectResponse,
  type RealtimeChangeEventDto,
  type RealtimeReadyEventDto,
  type RealtimeResyncEventDto,
  type StartTaskResponse,
  type TaskResponse,
} from "@prood/contracts";
import type { TaskPublicId, WorkspaceId } from "@prood/domain";
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
  shutdownServerResources,
  type RealtimeAppOptions,
} from "@prood/server";
import type { ProodShellElement as ProodShellElementType } from "@prood/web";

const targetDb = process.env.PROOD_TEST_DB as DbDriverKind | undefined;
if (targetDb !== "sqlite" && targetDb !== "postgres") {
  throw new Error(
    `PROOD_TEST_DB must be "sqlite" or "postgres" (received: ${String(targetDb)})`,
  );
}

const AUTH_SECRET = "prood-pr12-sse-web-realtime-secret-32-chars!";

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
  vi.unstubAllGlobals();
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

async function createIsolatedDb(): Promise<IsolatedDb> {
  const opened: KyselyBackedDatabaseClient[] = [];

  if (targetDb === "sqlite") {
    const dir = mkdtempSync(join(tmpdir(), "prood-pr12-sqlite-"));
    const filePath = join(dir, "pr12.sqlite");
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

  const schema = `prood_pr12_${Date.now().toString(36)}_${Math.random()
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

function createPkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

interface ParsedSseFrame {
  id: string | null;
  event: string;
  data: unknown;
  rawData: string;
}

interface SseClientHandle {
  frames: ParsedSseFrame[];
  waitForFrame(
    predicate: (frame: ParsedSseFrame) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<ParsedSseFrame>;
  waitUntilClosed(timeoutMs?: number): Promise<void>;
  close(): void;
}

async function connectSseClient(
  url: string,
  options: { jar: CookieJar; lastEventId?: string },
): Promise<{ status: number; headers: Headers; stream: SseClientHandle }> {
  const controller = new AbortController();
  const headers = new Headers();
  headers.set("accept", "text/event-stream");
  const cookieHeader = options.jar.toHeader();
  if (cookieHeader) {
    headers.set("cookie", cookieHeader);
  }
  if (options.lastEventId) {
    headers.set("last-event-id", options.lastEventId);
  }

  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: controller.signal,
  });

  const frames: ParsedSseFrame[] = [];
  let closed = !res.ok || !res.body;
  const closeWaiters: Array<() => void> = [];
  const frameWaiters: Array<() => void> = [];

  const notifyAll = () => {
    for (const w of frameWaiters.splice(0)) w();
  };
  const markClosed = () => {
    closed = true;
    notifyAll();
    for (const w of closeWaiters.splice(0)) w();
  };

  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const normalized = buffer.replace(/\r\n/g, "\n");
          let sepIdx: number;
          let rest = normalized;
          while ((sepIdx = rest.indexOf("\n\n")) !== -1) {
            const block = rest.slice(0, sepIdx);
            rest = rest.slice(sepIdx + 2);
            if (!block.trim() || block.startsWith(":")) {
              continue;
            }
            let id: string | null = null;
            let event = "message";
            const dataLines: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) continue;
              const colonIdx = line.indexOf(":");
              const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
              const valRaw = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
              const val = valRaw.startsWith(" ") ? valRaw.slice(1) : valRaw;
              if (field === "id") id = val;
              else if (field === "event") event = val;
              else if (field === "data") dataLines.push(val);
            }
            if (dataLines.length > 0) {
              const rawData = dataLines.join("\n");
              let parsedData: unknown = rawData;
              try {
                parsedData = JSON.parse(rawData);
              } catch {
                // Keep raw string
              }
              frames.push({ id, event, data: parsedData, rawData });
              notifyAll();
            }
          }
          buffer = rest;
        }
      } catch {
        // Expected on abort/close
      } finally {
        markClosed();
      }
    })();
  }

  const handle: SseClientHandle = {
    frames,
    async waitForFrame(predicate, label, timeoutMs = 6000) {
      const existing = frames.find(predicate);
      if (existing) return existing;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = frames.find(predicate);
        if (hit) return hit;
        if (closed) {
          throw new Error(`SSE stream closed before frame: ${label}`);
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 40);
          frameWaiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      throw new Error(`Timed out waiting for SSE frame: ${label}`);
    },
    async waitUntilClosed(timeoutMs = 5000) {
      if (closed) return;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error("Timed out waiting for SSE stream close")),
          timeoutMs,
        );
        closeWaiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    },
    close() {
      controller.abort();
      markClosed();
    },
  };

  cleanups.push(async () => {
    handle.close();
  });

  return { status: res.status, headers: res.headers, stream: handle };
}

const NativeEventTarget = globalThis.EventTarget;
const NativeEvent = globalThis.Event;
const NativeMessageEvent = globalThis.MessageEvent;

/**
 * Fetch-backed EventSource shim for happy-dom that preserves CookieJar headers
 * and `Last-Event-ID` over real HTTP against our Hono server.
 */
function createFetchEventSourceClass(baseUrl: string, jar: CookieJar) {
  return class FetchEventSource extends NativeEventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 0;
    readonly url: string;
    readonly withCredentials: boolean;
    private abortController = new AbortController();
    private lastEventId = "";

    constructor(url: string | URL, init?: EventSourceInit) {
      super();
      this.url = new URL(url.toString(), baseUrl).toString();
      this.withCredentials = Boolean(init?.withCredentials);
      void this.connect();
    }

    private async connect(): Promise<void> {
      try {
        const headers = new Headers();
        headers.set("accept", "text/event-stream");
        headers.set("origin", baseUrl);
        const cookieHeader = jar.toHeader();
        if (cookieHeader) headers.set("cookie", cookieHeader);
        if (this.lastEventId) headers.set("last-event-id", this.lastEventId);

        const res = await fetch(this.url, {
          method: "GET",
          headers,
          signal: this.abortController.signal,
        });
        if (!res.ok || !res.body) {
          this.readyState = 2;
          this.dispatchEvent(new NativeEvent("error"));
          return;
        }
        this.readyState = 1;
        this.dispatchEvent(new NativeEvent("open"));

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const normalized = buffer.replace(/\r\n/g, "\n");
          let idx: number;
          let rest = normalized;
          while ((idx = rest.indexOf("\n\n")) !== -1) {
            const block = rest.slice(0, idx);
            rest = rest.slice(idx + 2);
            if (!block.trim() || block.startsWith(":")) continue;
            let event = "message";
            const dataLines: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) continue;
              const colonIdx = line.indexOf(":");
              const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
              const rawVal = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
              const val = rawVal.startsWith(" ") ? rawVal.slice(1) : rawVal;
              if (field === "id") this.lastEventId = val;
              else if (field === "event") event = val;
              else if (field === "data") dataLines.push(val);
            }
            if (dataLines.length > 0) {
              this.dispatchEvent(
                new NativeMessageEvent(event, {
                  data: dataLines.join("\n"),
                  lastEventId: this.lastEventId,
                }),
              );
            }
          }
          buffer = rest;
        }
        if (!this.abortController.signal.aborted) {
          this.readyState = 2;
          this.dispatchEvent(new NativeEvent("error"));
        }
      } catch {
        if (!this.abortController.signal.aborted) {
          this.readyState = 2;
          this.dispatchEvent(new NativeEvent("error"));
        }
      }
    }

    close(): void {
      this.readyState = 2;
      this.abortController.abort();
    }
  };
}

async function startRealtimeTestServer(
  db: KyselyBackedDatabaseClient,
  options: {
    realtime?: Omit<RealtimeAppOptions, "shutdownSignal">;
    advanceClockOnCall?: boolean;
  } = {},
) {
  let currentMs = Date.now();
  const clock = {
    now: () => {
      if (options.advanceClockOnCall !== false) {
        currentMs += 1000;
      }
      return new Date(currentMs);
    },
    setTime(iso: string) {
      currentMs = Date.parse(iso);
    },
    advanceMs(ms: number) {
      currentMs += ms;
    },
  };

  const httpServer: HttpServer = createServer();
  await new Promise<void>((resolveListen) => {
    httpServer.listen(0, "127.0.0.1", () => resolveListen());
  });

  const addr = httpServer.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Expected numeric port");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const mcpResource = `${baseUrl}/mcp`;

  const idGenerator = createSystemIdGenerator();
  const realtimeHub = createRealtimeHub();
  const realtimeShutdown = new AbortController();

  const auth = createBetterAuthAdapter({
    db,
    secret: AUTH_SECRET,
    baseURL: baseUrl,
    trustedOrigins: [baseUrl],
    mcpResource,
  });

  const workUseCases = createWorkUseCases({
    uow: db.uow,
    idGenerator,
    clock,
    realtimeHub,
  });

  const realtimeUseCases = createRealtimeUseCases({
    uow: db.uow,
    clock,
    idGenerator,
    retentionMs: options.realtime?.retentionMs,
    maxEvents: options.realtime?.maxEvents,
  });

  const mcpHandler = createProodMcpServer({
    resource: mcpResource,
    tokenVerifier: auth,
    uow: db.uow,
    idGenerator,
    clock,
    realtimeHub,
    trustedOrigins: [baseUrl],
  });

  const app = createApp({
    clock,
    dbHealth: db,
    auth,
    uow: db.uow,
    idGenerator,
    mcpAuth: auth,
    mcpHandler,
    realtimeHub,
    realtime: {
      pollIntervalMs: options.realtime?.pollIntervalMs ?? 50,
      heartbeatIntervalMs: options.realtime?.heartbeatIntervalMs ?? 10_000,
      retryMs: options.realtime?.retryMs ?? 500,
      retentionMs: options.realtime?.retentionMs,
      maxEvents: options.realtime?.maxEvents,
      maxBufferedBytes: options.realtime?.maxBufferedBytes,
      maxBackpressureMs: options.realtime?.maxBackpressureMs,
      shutdownSignal: realtimeShutdown.signal,
    },
  });

  httpServer.on("request", createNodeAppListener(app));

  let closed = false;
  const closeServer = async () => {
    if (closed) return;
    closed = true;
    await shutdownServerResources({
      server: httpServer,
      closeMcp: mcpHandler.close,
      closeRealtime: () => realtimeShutdown.abort(),
      closeDb: async () => {},
      timeoutMs: 1000,
    });
  };
  cleanups.push(closeServer);

  async function apiRequest(
    path: string,
    init: { method?: string; json?: unknown; jar?: CookieJar } = {},
  ): Promise<Response> {
    const headers = new Headers();
    headers.set("origin", baseUrl);
    if (init.jar) {
      const cookieHeader = init.jar.toHeader();
      if (cookieHeader) headers.set("cookie", cookieHeader);
    }
    let body: string | undefined;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
    });
    init.jar?.updateFrom(res);
    return res;
  }

  async function signUpUser(email: string, name: string) {
    const jar = new CookieJar();
    const res = await apiRequest("/api/auth/sign-up/email", {
      method: "POST",
      jar,
      json: { email, password: "prood-test-password-123", name },
    });
    expect(res.status).toBe(200);
    const meRes = await apiRequest("/api/v1/me", { jar });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as MeResponse;
    return { jar, userId: me.user.id, email: me.user.email, displayName: name };
  }

  async function connectMcpClient(userJar: CookieJar) {
    const regRes = await fetch(`${baseUrl}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        client_name: "PR12 SSE MCP Client",
        redirect_uris: ["http://127.0.0.1/cb"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: `${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
      }),
    });
    expect([200, 201]).toContain(regRes.status);
    const registered = (await regRes.json()) as { client_id: string };

    const { verifier, challenge } = createPkcePair();
    const authUrl = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", registered.client_id);
    authUrl.searchParams.set("redirect_uri", "http://127.0.0.1/cb");
    authUrl.searchParams.set("scope", `${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`);
    authUrl.searchParams.set("state", "pr12-state");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", mcpResource);

    const authRes = await fetch(authUrl.toString(), {
      headers: { accept: "text/html", cookie: userJar.toHeader() },
      redirect: "manual",
    });
    let location = authRes.headers.get("location");
    if (authRes.status === 200) {
      const authJson = (await authRes.json()) as { url?: string };
      location = authJson.url ?? null;
    } else {
      expect(authRes.status).toBe(302);
    }
    const consentRedirect = new URL(location!, baseUrl);
    let code = consentRedirect.searchParams.get("code");
    if (!code) {
      const consentPost = await fetch(`${baseUrl}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: userJar.toHeader(),
          origin: baseUrl,
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: consentRedirect.search.slice(1),
        }),
      });
      expect(consentPost.status).toBe(200);
      const consentData = (await consentPost.json()) as {
        redirect_uri?: string;
        url?: string;
      };
      code = new URL(consentData.redirect_uri ?? consentData.url!).searchParams.get(
        "code",
      );
    }

    const tokenRes = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: "http://127.0.0.1/cb",
        client_id: registered.client_id,
        code_verifier: verifier,
        resource: mcpResource,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const token = (await tokenRes.json()) as { access_token: string };

    const transport = new StreamableHTTPClientTransport(new URL(mcpResource), {
      requestInit: {
        headers: { authorization: `Bearer ${token.access_token}` },
      },
    });
    const client = new Client(
      { name: "pr12-mcp-client", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    cleanups.push(async () => {
      await client.close();
      await transport.close();
    });
    return client;
  }

  async function mountBrowserShell(jar: CookieJar) {
    vi.resetModules();
    const win = new Window({ url: `${baseUrl}/` });
    const doc = win.document as unknown as Document;

    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("HTMLElement", win.HTMLElement);
    vi.stubGlobal("HTMLInputElement", win.HTMLInputElement);
    vi.stubGlobal("HTMLTextAreaElement", win.HTMLTextAreaElement);
    vi.stubGlobal("HTMLSelectElement", win.HTMLSelectElement);
    vi.stubGlobal("HTMLDialogElement", win.HTMLDialogElement);
    vi.stubGlobal("Element", win.Element);
    vi.stubGlobal("Node", win.Node);
    vi.stubGlobal("Event", win.Event);
    vi.stubGlobal("KeyboardEvent", win.KeyboardEvent);
    vi.stubGlobal("CustomEvent", win.CustomEvent);
    vi.stubGlobal("customElements", win.customElements);
    vi.stubGlobal("EventSource", createFetchEventSourceClass(baseUrl, jar));
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const origFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (input instanceof Request) {
          return origFetch(input, init);
        }
        const rawUrl = typeof input === "string" ? input : input.toString();
        const url = new URL(rawUrl, baseUrl);
        const headers = new Headers(init?.headers);
        headers.set("origin", baseUrl);
        const cookieHeader = jar.toHeader();
        if (cookieHeader && !headers.has("authorization")) {
          headers.set("cookie", cookieHeader);
        }
        const res = await origFetch(url.toString(), {
          ...init,
          headers,
        });
        jar.updateFrom(res);
        return res;
      },
    );

    const web = await import("@prood/web");
    web.registerProodLoginForm();
    web.registerProodShell();

    const shell = doc.createElement("prood-shell") as unknown as ProodShellElementType;
    doc.body.appendChild(shell as unknown as Node);
    cleanups.push(async () => {
      shell.remove();
    });
    return { win, doc, shell };
  }

  return {
    app,
    baseUrl,
    clock,
    httpServer,
    workUseCases,
    realtimeUseCases,
    realtimeHub,
    apiRequest,
    signUpUser,
    connectMcpClient,
    mountBrowserShell,
    closeServer,
  };
}

describe(`PR 12: SSE Realtime Web Sync & Commit-Order Visibility (${targetDb})`, () => {
  it("migrates cleanly from v9 to v10 preserving data and SQLite FK integrity", async () => {
    const isolated = await createIsolatedDb();
    const dbV9 = isolated.openClient();
    const v9 = await dbV9.migrate({ targetVersion: 9 });
    expect(v9.currentVersion).toBe(9);

    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    const prjId = ids.next("prj");
    const tskId = ids.next("tsk");
    const now = "2026-11-28T12:00:00.000Z";
    await dbV9.uow.run(async (repos) => {
      await repos.workspaces.create({ id: wksId, slug: "v9-ws", name: "V9 WS", createdAt: now });
      await repos.projects.create({
        id: prjId,
        workspaceId: wksId,
        kind: "general",
        visibility: "workspace",
        name: "V9 Project",
        description: "",
        createdAt: now,
      });
      await repos.tasks.create({
        id: tskId,
        workspaceId: wksId,
        projectId: prjId,
        parentTaskId: null,
        statusId: null,
        title: "Legacy V9 Task",
        description: "",
        assigneeId: null,
        createdBy: null,
        dueOn: null,
        position: 0,
        createdAt: now,
      });
    });
    await dbV9.close();

    const dbV10 = isolated.openClient();
    const upgrade = await dbV10.migrate();
    expect(upgrade).toEqual({ appliedVersions: [10], currentVersion: 10 });

    const existing = await dbV10.uow.run((repos) => repos.tasks.findById(tskId));
    expect(existing?.title).toBe("Legacy V9 Task");

    if (targetDb === "sqlite" && isolated.sqliteFilePath) {
      await dbV10.close();
      const native = openSqliteConnection(isolated.sqliteFilePath);
      try {
        expect(native.pragma("foreign_key_check")).toEqual([]);
      } finally {
        native.close();
      }
    }
  });

  it("streams MCP start_task updates in real time onto open Web List UI", async () => {
    const isolated = await createIsolatedDb();
    const db = isolated.openClient();
    await db.migrate();
    const server = await startRealtimeTestServer(db);
    const ids = createSystemIdGenerator();
    const now = server.clock.now().toISOString();

    const wksId = ids.next("wks");
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "live-ws",
        name: "Live Workspace",
        createdAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksId,
        defaultLocale: "en",
        devProjectsEnabled: true,
        updatedAt: now,
      });
    });

    const alice = await server.signUpUser("alice-live@example.com", "Alice Dev");
    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: alice.userId,
        role: "admin",
        createdAt: now,
      });
    });

    const projRes = await server.apiRequest(`/api/v1/workspaces/${wksId}/projects`, {
      method: "POST",
      jar: alice.jar,
      json: { name: "Realtime Board", visibility: "workspace" },
    });
    expect(projRes.status).toBe(201);
    const project = ((await projRes.json()) as ProjectResponse).project;
    const inProgress = project.statuses.find((s) => s.category === "in_progress")!;

    const taskRes = await server.apiRequest(`/api/v1/projects/${project.id}/tasks`, {
      method: "POST",
      jar: alice.jar,
      json: { title: "Wire SSE into task list" },
    });
    expect(taskRes.status).toBe(201);
    const task = ((await taskRes.json()) as TaskResponse).task;

    const browser = await server.mountBrowserShell(alice.jar);
    await waitFor(
      () => browser.doc.querySelector(`[data-task-row="${task.id}"]`) !== null,
      "open Web List renders task row",
    );
    const initialRow = browser.doc.querySelector(`[data-task-row="${task.id}"]`)!;
    expect(
      initialRow.querySelector("[data-task-assignee]")?.textContent?.trim(),
    ).toBe("—");

    const mcp = await server.connectMcpClient(alice.jar);
    const startToolRes = await mcp.callTool({
      name: "start_task",
      arguments: { taskRef: task.id },
    });
    const started = JSON.parse(
      (startToolRes.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as StartTaskResponse;
    expect(started.task.assigneeId).toBe(alice.userId);
    expect(started.task.statusId).toBe(inProgress.id);

    await waitFor(() => {
      const row = browser.doc.querySelector(`[data-task-row="${task.id}"]`);
      return (
        row?.querySelector("[data-task-status]")?.getAttribute("data-task-status") ===
          inProgress.id &&
        row?.querySelector("[data-task-assignee]")?.getAttribute("data-task-assignee") ===
          alice.userId
      );
    }, "Web List reflects MCP start_task status and assignee via SSE");

    const updatedRow = browser.doc.querySelector(`[data-task-row="${task.id}"]`)!;
    expect(
      updatedRow.querySelector("[data-task-assignee]")?.textContent?.trim(),
    ).toBe("Alice Dev");
    expect(updatedRow.className).toContain("prood-row-highlight");
    expect(
      browser.doc.querySelector("[data-live-region]")?.textContent,
    ).toContain("Wire SSE into task list");
  }, 20_000);

  it("resumes missed updates via Last-Event-ID and triggers full resync on expired cursor", async () => {
    const isolated = await createIsolatedDb();
    const db = isolated.openClient();
    await db.migrate();
    const server = await startRealtimeTestServer(db, {
      realtime: { pollIntervalMs: 40, retentionMs: 60_000 },
    });
    const ids = createSystemIdGenerator();
    const now = server.clock.now().toISOString();

    const wksId = ids.next("wks");
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "resume-ws",
        name: "Resume Workspace",
        createdAt: now,
      });
    });
    const alice = await server.signUpUser("alice-resume@example.com", "Alice");
    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: alice.userId,
        role: "admin",
        createdAt: now,
      });
    });

    const projRes = await server.apiRequest(`/api/v1/workspaces/${wksId}/projects`, {
      method: "POST",
      jar: alice.jar,
      json: { name: "Resume Project", visibility: "workspace" },
    });
    const project = ((await projRes.json()) as ProjectResponse).project;

    const sse1 = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksId}/events`,
      { jar: alice.jar },
    );
    expect(sse1.status).toBe(200);
    const readyFrame = await sse1.stream.waitForFrame(
      (f) => f.event === "ready",
      "initial ready frame",
    );
    const initialCursor = (readyFrame.data as RealtimeReadyEventDto).cursor;
    sse1.stream.close();

    // Perform mutations while disconnected
    const createRes = await server.apiRequest(`/api/v1/projects/${project.id}/tasks`, {
      method: "POST",
      jar: alice.jar,
      json: { title: "Missed While Offline" },
    });
    const offlineTask = ((await createRes.json()) as TaskResponse).task;
    await server.apiRequest(`/api/v1/tasks/${offlineTask.id}/start`, {
      method: "POST",
      jar: alice.jar,
    });

    // Reconnect using Last-Event-ID -> recovers created + started in order
    const sse2 = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksId}/events`,
      { jar: alice.jar, lastEventId: initialCursor },
    );
    await sse2.stream.waitForFrame(
      (f) =>
        f.event === "change" &&
        (f.data as RealtimeChangeEventDto).eventType === "task.started" &&
        (f.data as RealtimeChangeEventDto).taskId === offlineTask.id,
      "resumed task.started event",
    );
    const resumedTypes = sse2.stream.frames
      .filter((f) => f.event === "change")
      .map((f) => (f.data as RealtimeChangeEventDto).eventType);
    expect(resumedTypes).toEqual(["task.created", "task.started"]);
    sse2.stream.close();

    // Advance clock past retentionMs so initialCursor expires
    server.clock.advanceMs(120_000);
    await server.apiRequest(`/api/v1/projects/${project.id}/tasks`, {
      method: "POST",
      jar: alice.jar,
      json: { title: "Fresh Task After Retention" },
    });

    const sse3 = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksId}/events`,
      { jar: alice.jar, lastEventId: initialCursor },
    );
    const resyncFrame = await sse3.stream.waitForFrame(
      (f) => f.event === "resync",
      "resync on expired cursor",
    );
    const resyncPayload = resyncFrame.data as RealtimeResyncEventDto;
    expect(resyncPayload.reason).toBe("cursor_expired");
    expect(resyncPayload.cursor).not.toBe(initialCursor);
    sse3.stream.close();

    // Also verify invalid cursor emits resync reason cursor_invalid
    const sse4 = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksId}/events?cursor=bad-cursor`,
      { jar: alice.jar },
    );
    const invalidResync = await sse4.stream.waitForFrame(
      (f) => f.event === "resync",
      "resync on invalid cursor",
    );
    expect((invalidResync.data as RealtimeResyncEventDto).reason).toBe("cursor_invalid");
    sse4.stream.close();
  }, 20_000);

  it("blocks uncommitted, private, moved-to-private, and access-revoked leaks", async () => {
    const isolated = await createIsolatedDb();
    const db = isolated.openClient({ maxPoolSize: 10 });
    await db.migrate();
    const server = await startRealtimeTestServer(db, {
      realtime: { pollIntervalMs: 40 },
    });
    const ids = createSystemIdGenerator();
    const now = server.clock.now().toISOString();

    const wksA = ids.next("wks");
    const wksB = ids.next("wks");
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({ id: wksA, slug: "sec-a", name: "Sec A", createdAt: now });
      await repos.workspaces.create({ id: wksB, slug: "sec-b", name: "Sec B", createdAt: now });
    });

    const admin = await server.signUpUser("sec-admin@example.com", "Admin");
    const member = await server.signUpUser("sec-member@example.com", "Member");
    const outsider = await server.signUpUser("sec-outsider@example.com", "Outsider");

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
        userId: member.userId,
        role: "member",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksB,
        userId: outsider.userId,
        role: "admin",
        createdAt: now,
      });
    });

    const pubProj = ((
      await (
        await server.apiRequest(`/api/v1/workspaces/${wksA}/projects`, {
          method: "POST",
          jar: admin.jar,
          json: { name: "Shared Proj", visibility: "workspace" },
        })
      ).json()
    ) as ProjectResponse).project;
    const privProj = ((
      await (
        await server.apiRequest(`/api/v1/workspaces/${wksA}/projects`, {
          method: "POST",
          jar: admin.jar,
          json: { name: "Secret Vault", visibility: "private" },
        })
      ).json()
    ) as ProjectResponse).project;

    // Non-member rejected at HTTP handshake
    const outsiderRes = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksA}/events`,
      { jar: outsider.jar },
    );
    expect(outsiderRes.status).toBe(403);
    outsiderRes.stream.close();

    const memberPrivRes = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksA}/events?projectId=${privProj.id}`,
      { jar: member.jar },
    );
    expect(memberPrivRes.status).toBe(404);
    memberPrivRes.stream.close();

    // Member opens workspace SSE stream
    const memberSse = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksA}/events`,
      { jar: member.jar },
    );
    await memberSse.stream.waitForFrame((f) => f.event === "ready", "member ready");

    // 1. Rolled-back transaction must emit zero events
    const rolledBackTaskId = ids.next("tsk");
    await expect(
      db.uow.run(async (repos) => {
        const created = await repos.tasks.create({
          id: rolledBackTaskId,
          workspaceId: wksA,
          projectId: pubProj.id,
          parentTaskId: null,
          statusId: pubProj.statuses[0]!.id,
          title: "Should Rollback",
          description: "",
          assigneeId: null,
          createdBy: admin.userId,
          dueOn: null,
          position: 0,
          createdAt: now,
        });
        await repos.realtimeEvents.append({
          workspaceId: wksA,
          projectId: pubProj.id,
          eventId: ids.next("evt"),
          eventType: "task.created",
          targetType: "task",
          targetId: created.id,
          payload: {},
          occurredAt: now,
          createdAt: now,
        });
        throw new Error("Force rollback");
      }),
    ).rejects.toThrow("Force rollback");

    // 2. Private project task must never leak to non-member
    const privTask = ((
      await (
        await server.apiRequest(`/api/v1/projects/${privProj.id}/tasks`, {
          method: "POST",
          jar: admin.jar,
          json: { title: "Top Secret Task" },
        })
      ).json()
    ) as TaskResponse).task;

    // 3. Task created in Shared Proj -> then moved to Secret Vault
    const sharedTask = ((
      await (
        await server.apiRequest(`/api/v1/projects/${pubProj.id}/tasks`, {
          method: "POST",
          jar: admin.jar,
          json: { title: "Moved Secret Task" },
        })
      ).json()
    ) as TaskResponse).task;
    await memberSse.stream.waitForFrame(
      (f) =>
        f.event === "change" &&
        (f.data as RealtimeChangeEventDto).taskId === sharedTask.id &&
        (f.data as RealtimeChangeEventDto).eventType === "task.created",
      "member sees shared task creation",
    );

    await server.apiRequest(`/api/v1/tasks/${sharedTask.id}/move`, {
      method: "POST",
      jar: admin.jar,
      json: { projectId: privProj.id },
    });
    const removedFrame = await memberSse.stream.waitForFrame(
      (f) =>
        f.event === "change" &&
        (f.data as RealtimeChangeEventDto).taskId === sharedTask.id &&
        (f.data as RealtimeChangeEventDto).eventType === "task.removed",
      "member receives sanitized task.removed when task moved to private project",
    );
    const removedPayload = removedFrame.data as RealtimeChangeEventDto;
    expect(removedPayload.projectId).toBe(pubProj.id);
    expect(removedPayload.task).toBeUndefined();
    expect(JSON.stringify(memberSse.stream.frames)).not.toContain(privProj.id);
    expect(JSON.stringify(memberSse.stream.frames)).not.toContain(privTask.id);
    expect(JSON.stringify(memberSse.stream.frames)).not.toContain(rolledBackTaskId);

    // 4. Workspace access revocation mid-stream immediately sends revoked & closes
    await db.uow.run(async (repos) => {
      await repos.memberships.deleteByWorkspaceAndUser(wksA, member.userId);
    });
    await server.apiRequest(`/api/v1/projects/${pubProj.id}/tasks`, {
      method: "POST",
      jar: admin.jar,
      json: { title: "After Member Revoked" },
    });
    await memberSse.stream.waitForFrame((f) => f.event === "revoked", "revoked frame");
    await memberSse.stream.waitUntilClosed();
    expect(JSON.stringify(memberSse.stream.frames)).not.toContain("After Member Revoked");
  }, 20_000);

  it("never drops out-of-order concurrent commits", async () => {
    const isolated = await createIsolatedDb();
    const db1 = isolated.openClient({ maxPoolSize: 10 });
    const db2 = isolated.openClient({ maxPoolSize: 10 });
    await db1.migrate();

    const server = await startRealtimeTestServer(db1, {
      realtime: { pollIntervalMs: 30 },
    });
    const ids = createSystemIdGenerator();
    const now = server.clock.now().toISOString();

    const wksId = ids.next("wks");
    await db1.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "ooo-ws",
        name: "OOO Workspace",
        createdAt: now,
      });
    });
    const admin = await server.signUpUser("ooo-admin@example.com", "Admin");
    await db1.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: admin.userId,
        role: "admin",
        createdAt: now,
      });
    });
    const project = ((
      await (
        await server.apiRequest(`/api/v1/workspaces/${wksId}/projects`, {
          method: "POST",
          jar: admin.jar,
          json: { name: "OOO Project", visibility: "workspace" },
        })
      ).json()
    ) as ProjectResponse).project;

    const sse = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksId}/events`,
      { jar: admin.jar },
    );
    await sse.stream.waitForFrame((f) => f.event === "ready", "ooo ready");

    if (targetDb === "postgres") {
      // Tx1 allocates earlier txid + seq and pauses before COMMIT
      let resolveTx1Written!: () => void;
      const tx1Written = new Promise<void>((r) => {
        resolveTx1Written = r;
      });
      let resolveTx1Release!: () => void;
      const tx1Release = new Promise<void>((r) => {
        resolveTx1Release = r;
      });
      const task1Id = ids.next("tsk");
      const evt1Id = ids.next("evt");

      const tx1Promise = db1.uow.run(async (repos) => {
        await repos.tasks.create({
          id: task1Id,
          workspaceId: wksId,
          projectId: project.id,
          parentTaskId: null,
          statusId: project.statuses[0]!.id,
          title: "Tx1 Earlier Write Late Commit",
          description: "",
          assigneeId: null,
          createdBy: admin.userId,
          dueOn: null,
          position: 0,
          createdAt: now,
        });
        await repos.realtimeEvents.append({
          workspaceId: wksId,
          projectId: project.id,
          eventId: evt1Id,
          eventType: "task.created",
          targetType: "task",
          targetId: task1Id,
          payload: {},
          occurredAt: now,
          createdAt: now,
        });
        resolveTx1Written();
        await tx1Release;
      });

      await tx1Written;

      // Tx2 runs via db2 and commits FIRST, followed by 550+ committed transactions
      // while Tx1 continues to hold PostgreSQL's `xmin` open.
      const useCases2 = createWorkUseCases({
        uow: db2.uow,
        idGenerator: ids,
        clock: server.clock,
        realtimeHub: server.realtimeHub,
      });
      const tx2Res = await useCases2.createTask(
        { userId: admin.userId, actorType: "user", channel: "mcp" },
        project.id,
        { title: "Tx2 Later Write Early Commit" },
      );
      expect(tx2Res.ok).toBe(true);
      const task2Id = tx2Res.ok ? tx2Res.data.task.id : ("" as TaskPublicId);

      // Commit 550 independent transactions (> MAX_PENDING_XIPS 512) while Tx1 holds xmin
      const burstCount = 550;
      const workers = 10;
      const perWorker = burstCount / workers;
      await Promise.all(
        Array.from({ length: workers }, async () => {
          for (let i = 0; i < perWorker; i += 1) {
            await db2.uow.run(async (repos) => {
              await repos.realtimeEvents.append({
                workspaceId: wksId,
                projectId: null,
                eventId: ids.next("evt"),
                eventType: "workspace.settings.updated",
                targetType: "workspace",
                targetId: wksId,
                payload: {},
                occurredAt: now,
                createdAt: now,
              });
            });
          }
        }),
      );
      server.realtimeHub.notify(wksId);

      // Live SSE receives Tx2 plus all 550 burst events across multi-page batches without overflow/resync
      await sse.stream.waitForFrame(
        (f) =>
          f.event === "change" &&
          (f.data as RealtimeChangeEventDto).taskId === task2Id,
        "live SSE receives Tx2 before Tx1 commits",
      );
      await waitFor(
        () =>
          sse.stream.frames.filter(
            (f) =>
              f.event === "change" &&
              (f.data as RealtimeChangeEventDto).eventType ===
                "workspace.settings.updated",
          ).length === burstCount,
        "live SSE drains all 550 committed events while xmin is pinned",
        15_000,
      );
      expect(sse.stream.frames.some((f) => f.event === "resync")).toBe(false);
      const lastBurstFrame = sse.stream.frames
        .filter((f) => f.event === "change")
        .at(-1)!;
      const cursorAfterBurst = (lastBurstFrame.data as RealtimeChangeEventDto).cursor;

      // Now commit Tx1!
      resolveTx1Release();
      await tx1Promise;
      server.realtimeHub.notify(wksId);

      // Both live stream AND fresh reconnect from cursorAfterBurst must receive Tx1 without duplicating Tx2 or burst!
      await sse.stream.waitForFrame(
        (f) =>
          f.event === "change" &&
          (f.data as RealtimeChangeEventDto).taskId === task1Id,
        "live SSE delivers late-committing Tx1",
      );
      expect(
        sse.stream.frames.filter(
          (f) => f.event === "change" && (f.data as RealtimeChangeEventDto).taskId === task2Id,
        ),
      ).toHaveLength(1);
      sse.stream.close();

      const sseResume = await connectSseClient(
        `${server.baseUrl}/api/v1/workspaces/${wksId}/events`,
        { jar: admin.jar, lastEventId: cursorAfterBurst },
      );
      await sseResume.stream.waitForFrame(
        (f) =>
          f.event === "change" &&
          (f.data as RealtimeChangeEventDto).taskId === task1Id,
        "resumed SSE from cursorAfterBurst also delivers Tx1",
      );
      expect(
        sseResume.stream.frames.filter(
          (f) => f.event === "change" && (f.data as RealtimeChangeEventDto).taskId === task2Id,
        ),
      ).toHaveLength(0);
      sseResume.stream.close();
    } else {
      // SQLite serializes BEGIN IMMEDIATE commits: concurrent writers all commit and deliver cleanly
      const resList = await Promise.all([
        server.workUseCases.createTask(
          { userId: admin.userId, actorType: "user", channel: "mcp" },
          project.id,
          { title: "Concurrent SQLite Task 1" },
        ),
        createWorkUseCases({
          uow: db2.uow,
          idGenerator: ids,
          clock: server.clock,
          realtimeHub: server.realtimeHub,
        }).createTask(
          { userId: admin.userId, actorType: "user", channel: "web" },
          project.id,
          { title: "Concurrent SQLite Task 2" },
        ),
      ]);
      const expectedIds = resList.map((r) => (r.ok ? r.data.task.id : ""));
      for (const expectedId of expectedIds) {
        await sse.stream.waitForFrame(
          (f) =>
            f.event === "change" &&
            (f.data as RealtimeChangeEventDto).taskId === expectedId,
          `concurrent SQLite task ${expectedId}`,
        );
      }
      sse.stream.close();
    }
  }, 20_000);

  it("Stage 1 Exit: existing dev tasks stay readable & startable across Web+MCP after devProjectsEnabled revocation", async () => {
    const isolated = await createIsolatedDb();
    const db = isolated.openClient();
    await db.migrate();
    const server = await startRealtimeTestServer(db, {
      realtime: { pollIntervalMs: 40 },
    });
    const ids = createSystemIdGenerator();
    const now = server.clock.now().toISOString();

    const wksId = ids.next("wks");
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "stage1-exit-ws",
        name: "Stage 1 Exit",
        createdAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksId,
        defaultLocale: "en",
        devProjectsEnabled: true,
        updatedAt: now,
      });
    });

    const admin = await server.signUpUser("s1-admin@example.com", "Admin");
    const member = await server.signUpUser("s1-member@example.com", "Member Builder");
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

    const proj = ((
      await (
        await server.apiRequest(`/api/v1/workspaces/${wksId}/projects`, {
          method: "POST",
          jar: admin.jar,
          json: { name: "Stage 1 Dev", visibility: "workspace" },
        })
      ).json()
    ) as ProjectResponse).project;
    const inProgress = proj.statuses.find((s) => s.category === "in_progress")!;
    expect(
      (
        await server.apiRequest(`/api/v1/projects/${proj.id}/dev-settings/enable`, {
          method: "POST",
          jar: admin.jar,
          json: { prefix: "DEV", startStatusId: inProgress.id },
        })
      ).status,
    ).toBe(200);

    const t1 = ((
      await (
        await server.apiRequest(`/api/v1/projects/${proj.id}/tasks`, {
          method: "POST",
          jar: member.jar,
          json: { title: "Existing Keyed Task 1" },
        })
      ).json()
    ) as TaskResponse).task;
    const t2 = ((
      await (
        await server.apiRequest(`/api/v1/projects/${proj.id}/tasks`, {
          method: "POST",
          jar: member.jar,
          json: { title: "Existing Keyed Task 2" },
        })
      ).json()
    ) as TaskResponse).task;
    expect(t1.issueKey).toBe("DEV-1");
    expect(t2.issueKey).toBe("DEV-2");

    // Revoke workspace dev-project permission
    expect(
      (
        await server.apiRequest(`/api/v1/workspaces/${wksId}/settings`, {
          method: "PATCH",
          jar: admin.jar,
          json: { devProjectsEnabled: false },
        })
      ).status,
    ).toBe(200);
    const editBlocked = await server.apiRequest(
      `/api/v1/projects/${proj.id}/dev-settings`,
      { method: "PATCH", jar: admin.jar, json: { prefix: "NEWP" } },
    );
    expect(editBlocked.status).toBe(403);
    expect(((await editBlocked.json()) as ApiErrorResponse).error.messageKey).toBe(
      "error.devProjectsDisabled",
    );

    // Member keeps Web List open and uses MCP + Web to read & start existing tasks
    const browser = await server.mountBrowserShell(member.jar);
    await waitFor(
      () => browser.doc.querySelector(`[data-task-row="${t1.id}"]`) !== null,
      "member Web List shows existing tasks",
    );

    const mcp = await server.connectMcpClient(member.jar);
    const mcpGet = await mcp.callTool({
      name: "get_task",
      arguments: { taskRef: "DEV-1" },
    });
    expect(
      (
        JSON.parse(
          (mcpGet.content as Array<{ type: string; text: string }>)[0]!.text,
        ) as TaskResponse
      ).task.id,
    ).toBe(t1.id);

    const mcpStart = await mcp.callTool({
      name: "start_task",
      arguments: { taskRef: "DEV-1" },
    });
    const mcpStarted = JSON.parse(
      (mcpStart.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as StartTaskResponse;
    expect(mcpStarted.task.issueKey).toBe("DEV-1");
    expect(mcpStarted.task.branchName).toBe("dev-1");
    expect(mcpStarted.task.assigneeId).toBe(member.userId);
    expect(mcpStarted.task.statusId).toBe(inProgress.id);

    // Web UI updates DEV-1 via SSE
    await waitFor(() => {
      const row = browser.doc.querySelector(`[data-task-row="${t1.id}"]`);
      return (
        row?.querySelector("[data-task-status]")?.getAttribute("data-task-status") ===
          inProgress.id &&
        row?.querySelector("[data-task-assignee]")?.getAttribute("data-task-assignee") ===
          member.userId
      );
    }, "Web UI reflects DEV-1 start via SSE after dev permission revocation");

    // Web API can also read and start existing DEV-2
    const webGetT2 = await server.apiRequest(`/api/v1/tasks/DEV-2`, { jar: member.jar });
    expect(webGetT2.status).toBe(200);
    const webStartT2 = await server.apiRequest(`/api/v1/tasks/DEV-2/start`, {
      method: "POST",
      jar: member.jar,
    });
    expect(webStartT2.status).toBe(200);
    expect(((await webStartT2.json()) as StartTaskResponse).task.statusId).toBe(
      inProgress.id,
    );

    await waitFor(() => {
      const row = browser.doc.querySelector(`[data-task-row="${t2.id}"]`);
      return (
        row?.querySelector("[data-task-status]")?.getAttribute("data-task-status") ===
        inProgress.id
      );
    }, "Web UI reflects DEV-2 start via SSE");
  }, 20_000);

  it("aborts open SSE streams cleanly on graceful server shutdown", async () => {
    const isolated = await createIsolatedDb();
    const db = isolated.openClient();
    await db.migrate();
    const server = await startRealtimeTestServer(db);
    const ids = createSystemIdGenerator();
    const now = server.clock.now().toISOString();

    const wksId = ids.next("wks");
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "shutdown-ws",
        name: "Shutdown WS",
        createdAt: now,
      });
    });
    const admin = await server.signUpUser("shut-admin@example.com", "Admin");
    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: admin.userId,
        role: "admin",
        createdAt: now,
      });
    });

    const sse = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksId}/events`,
      { jar: admin.jar },
    );
    await sse.stream.waitForFrame((f) => f.event === "ready", "ready before shutdown");

    const t0 = Date.now();
    await server.closeServer();
    await sse.stream.waitUntilClosed(3000);
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 15_000);

  it("emits task.removed when moved task is deleted before poll and syncs subtask deletes/moves on Web List", async () => {
    const isolated = await createIsolatedDb();
    const db = isolated.openClient();
    await db.migrate();
    const server = await startRealtimeTestServer(db, {
      realtime: { pollIntervalMs: 40 },
    });
    const ids = createSystemIdGenerator();
    const now = server.clock.now().toISOString();

    const wksId = ids.next("wks");
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "subtree-ws",
        name: "Subtree WS",
        createdAt: now,
      });
    });

    const admin = await server.signUpUser("sub-admin@example.com", "Admin");
    const member = await server.signUpUser("sub-member@example.com", "Member");
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

    const projA = ((
      await (
        await server.apiRequest(`/api/v1/workspaces/${wksId}/projects`, {
          method: "POST",
          jar: admin.jar,
          json: { name: "Source Shared", visibility: "workspace" },
        })
      ).json()
    ) as ProjectResponse).project;
    const projBPriv = ((
      await (
        await server.apiRequest(`/api/v1/workspaces/${wksId}/projects`, {
          method: "POST",
          jar: admin.jar,
          json: { name: "Target Secret", visibility: "private" },
        })
      ).json()
    ) as ProjectResponse).project;
    const projCShared = ((
      await (
        await server.apiRequest(`/api/v1/workspaces/${wksId}/projects`, {
          method: "POST",
          jar: admin.jar,
          json: { name: "Target Shared", visibility: "workspace" },
        })
      ).json()
    ) as ProjectResponse).project;

    // 1. Moved-to-private then deleted before SSE poll: both workspace-wide member
    //    and `?projectId=projA` scoped admin receive sanitized `task.removed`.
    const movedThenDeleted = ((
      await (
        await server.apiRequest(`/api/v1/projects/${projA.id}/tasks`, {
          method: "POST",
          jar: admin.jar,
          json: { title: "Move Then Delete" },
        })
      ).json()
    ) as TaskResponse).task;

    const memberSseInit = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksId}/events`,
      { jar: member.jar },
    );
    const memberReady = await memberSseInit.stream.waitForFrame(
      (f) => f.event === "ready",
      "member initial ready",
    );
    const memberCursor = (memberReady.data as RealtimeReadyEventDto).cursor;
    memberSseInit.stream.close();

    const adminScopedInit = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksId}/events?projectId=${projA.id}`,
      { jar: admin.jar },
    );
    const adminReady = await adminScopedInit.stream.waitForFrame(
      (f) => f.event === "ready",
      "admin projA scoped ready",
    );
    const adminCursor = (adminReady.data as RealtimeReadyEventDto).cursor;
    adminScopedInit.stream.close();

    expect(
      (
        await server.apiRequest(`/api/v1/tasks/${movedThenDeleted.id}/move`, {
          method: "POST",
          jar: admin.jar,
          json: { projectId: projBPriv.id },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await server.apiRequest(`/api/v1/tasks/${movedThenDeleted.id}`, {
          method: "DELETE",
          jar: admin.jar,
        })
      ).status,
    ).toBe(200);

    const memberResume = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksId}/events`,
      { jar: member.jar, lastEventId: memberCursor },
    );
    const memberRemoved = await memberResume.stream.waitForFrame(
      (f) =>
        f.event === "change" &&
        (f.data as RealtimeChangeEventDto).eventType === "task.removed" &&
        (f.data as RealtimeChangeEventDto).taskId === movedThenDeleted.id,
      "member receives sanitized task.removed for moved+deleted task",
    );
    expect((memberRemoved.data as RealtimeChangeEventDto).projectId).toBe(projA.id);
    expect(JSON.stringify(memberResume.stream.frames)).not.toContain(projBPriv.id);
    memberResume.stream.close();

    const adminScopedResume = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksId}/events?projectId=${projA.id}`,
      { jar: admin.jar, lastEventId: adminCursor },
    );
    const adminRemoved = await adminScopedResume.stream.waitForFrame(
      (f) =>
        f.event === "change" &&
        (f.data as RealtimeChangeEventDto).eventType === "task.removed" &&
        (f.data as RealtimeChangeEventDto).taskId === movedThenDeleted.id,
      "scoped admin receives task.removed for projA",
    );
    expect((adminRemoved.data as RealtimeChangeEventDto).projectId).toBe(projA.id);
    adminScopedResume.stream.close();

    // 2. Web UI subtask synchronization: deleting or moving a parent updates/removes descendants
    const moveParent = ((
      await (
        await server.apiRequest(`/api/v1/projects/${projA.id}/tasks`, {
          method: "POST",
          jar: admin.jar,
          json: { title: "Move Parent" },
        })
      ).json()
    ) as TaskResponse).task;
    const moveChild = ((
      await (
        await server.apiRequest(`/api/v1/projects/${projA.id}/tasks`, {
          method: "POST",
          jar: admin.jar,
          json: {
            title: "Inherited Move Child",
            parentTaskId: moveParent.id,
            inheritParentProject: true,
          },
        })
      ).json()
    ) as TaskResponse).task;
    const delParent = ((
      await (
        await server.apiRequest(`/api/v1/projects/${projA.id}/tasks`, {
          method: "POST",
          jar: admin.jar,
          json: { title: "Delete Parent" },
        })
      ).json()
    ) as TaskResponse).task;
    const delChild = ((
      await (
        await server.apiRequest(`/api/v1/projects/${projA.id}/tasks`, {
          method: "POST",
          jar: admin.jar,
          json: {
            title: "Cascade Delete Child",
            parentTaskId: delParent.id,
            inheritParentProject: true,
          },
        })
      ).json()
    ) as TaskResponse).task;

    const browser = await server.mountBrowserShell(member.jar);
    await waitFor(
      () =>
        browser.doc.querySelector(`[data-task-row="${moveParent.id}"]`) !== null &&
        browser.doc.querySelector(`[data-task-row="${moveChild.id}"]`) !== null &&
        browser.doc.querySelector(`[data-task-row="${delParent.id}"]`) !== null &&
        browser.doc.querySelector(`[data-task-row="${delChild.id}"]`) !== null,
      "Web List shows both parents and subtasks",
    );

    // Move parent out to projCShared -> BOTH moveParent & moveChild disappear from Source Shared
    expect(
      (
        await server.apiRequest(`/api/v1/tasks/${moveParent.id}/move`, {
          method: "POST",
          jar: admin.jar,
          json: { projectId: projCShared.id },
        })
      ).status,
    ).toBe(200);
    await waitFor(
      () =>
        browser.doc.querySelector(`[data-task-row="${moveParent.id}"]`) === null &&
        browser.doc.querySelector(`[data-task-row="${moveChild.id}"]`) === null,
      "moving parent removes both parent and inherited subtask from Source Shared list",
    );

    // Delete parent -> BOTH delParent & delChild disappear from Web List
    expect(
      (
        await server.apiRequest(`/api/v1/tasks/${delParent.id}`, {
          method: "DELETE",
          jar: admin.jar,
        })
      ).status,
    ).toBe(200);
    await waitFor(
      () =>
        browser.doc.querySelector(`[data-task-row="${delParent.id}"]`) === null &&
        browser.doc.querySelector(`[data-task-row="${delChild.id}"]`) === null,
      "deleting parent removes both parent and subtask from Web List",
    );
  }, 25_000);

  it("reads retention metadata in the same snapshot and enforces SSE backpressure for slow subscribers", async () => {
    const isolated = await createIsolatedDb();
    const db = isolated.openClient({ maxPoolSize: 8 });
    await db.migrate();
    const server = await startRealtimeTestServer(db, {
      realtime: {
        pollIntervalMs: 25,
        heartbeatIntervalMs: 500,
        maxBufferedBytes: 256,
        maxBackpressureMs: 400,
      },
    });
    const ids = createSystemIdGenerator();
    const now = server.clock.now().toISOString();

    const wksId = ids.next("wks");
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "bp-ws",
        name: "Backpressure Workspace",
        createdAt: now,
      });
    });
    const alice = await server.signUpUser("alice-bp@example.com", "Alice");
    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: alice.userId,
        role: "admin",
        createdAt: now,
      });
    });

    const project = ((
      await (
        await server.apiRequest(`/api/v1/workspaces/${wksId}/projects`, {
          method: "POST",
          jar: alice.jar,
          json: { name: "BP Proj", visibility: "workspace" },
        })
      ).json()
    ) as ProjectResponse).project;

    // 1. Single-snapshot retention consistency on prune + listAfterPosition
    const snapBefore = await db.uow.run((repos) =>
      repos.realtimeEvents.readSnapshotState(wksId),
    );
    const createdForPrune = ((
      await (
        await server.apiRequest(`/api/v1/projects/${project.id}/tasks`, {
          method: "POST",
          jar: alice.jar,
          json: { title: "Pruned Target" },
        })
      ).json()
    ) as TaskResponse).task;
    await server.apiRequest(`/api/v1/tasks/${createdForPrune.id}/start`, {
      method: "POST",
      jar: alice.jar,
    });
    const pruneResult = await server.realtimeUseCases.pruneRealtimeEvents({
      keepLast: 0,
    });
    expect(pruneResult.deletedCount).toBeGreaterThanOrEqual(2);
    const listAfterPrune = await db.uow.run((repos) =>
      repos.realtimeEvents.listAfterPosition({
        workspaceId: wksId,
        watermarkTxid: snapBefore.xmax,
        watermarkSeq: snapBefore.maxSeq,
        pendingTxids: [],
        limit: 50,
      }),
    );
    expect(listAfterPrune.snapshot.retention.prunedThroughSeq).toBe(
      pruneResult.prunedThroughSeq,
    );

    // Helper to parse SSE frames from a ReadableStreamDefaultReader
    const parseChunks = (raw: string): ParsedSseFrame[] => {
      const parsed: ParsedSseFrame[] = [];
      for (const block of raw.split("\n\n")) {
        const trimmed = block.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        let id: string | null = null;
        let event = "message";
        const dataLines: string[] = [];
        for (const line of trimmed.split("\n")) {
          if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) {
          const rawData = dataLines.join("\n");
          parsed.push({ id, event, data: JSON.parse(rawData), rawData });
        }
      }
      return parsed;
    };

    // 2. Bounded backpressure pauses without dropping once consumer resumes reading
    const pauseServer = await startRealtimeTestServer(db, {
      realtime: {
        pollIntervalMs: 25,
        heartbeatIntervalMs: 500,
        maxBufferedBytes: 256,
        maxBackpressureMs: 5_000,
      },
    });
    const ac1 = new AbortController();
    cleanups.push(async () => ac1.abort());
    const slowRes = await pauseServer.app.request(
      `/api/v1/workspaces/${wksId}/events`,
      {
        headers: {
          accept: "text/event-stream",
          cookie: alice.jar.toHeader(),
          origin: pauseServer.baseUrl,
        },
        signal: ac1.signal,
      },
    );
    expect(slowRes.status).toBe(200);
    const reader1 = slowRes.body!.getReader();

    // Do NOT read yet while bursts arrive and multiple poll intervals tick
    const expectedTitles: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const title = `BP Resume Task ${i}`;
      expectedTitles.push(title);
      const res = await pauseServer.apiRequest(`/api/v1/projects/${project.id}/tasks`, {
        method: "POST",
        jar: alice.jar,
        json: { title },
      });
      expect(res.status).toBe(201);
    }
    await new Promise((r) => setTimeout(r, 150));

    // Consumer resumes reading -> pulls all 8 task.created events with zero loss
    const decoder = new TextDecoder();
    let acc1 = "";
    const deadline1 = Date.now() + 8_000;
    while (Date.now() < deadline1) {
      const { value, done } = await reader1.read();
      if (done) break;
      acc1 += decoder.decode(value, { stream: true });
      const titlesSeen = parseChunks(acc1)
        .filter((f) => f.event === "change")
        .map((f) => (f.data as RealtimeChangeEventDto).task?.title)
        .filter((t): t is string => Boolean(t));
      if (expectedTitles.every((t) => titlesSeen.includes(t))) {
        break;
      }
    }
    ac1.abort();
    await reader1.cancel().catch(() => {});
    const seen1 = parseChunks(acc1)
      .filter((f) => f.event === "change")
      .map((f) => (f.data as RealtimeChangeEventDto).task?.title);
    expect(seen1).toEqual(expectedTitles);

    // 3. Stalled slow subscriber exceeds maxBackpressureMs -> closes cleanly with bounded buffer & resumes via Last-Event-ID
    const ac2 = new AbortController();
    cleanups.push(async () => ac2.abort());
    const stalledRes = await server.app.request(
      `/api/v1/workspaces/${wksId}/events`,
      {
        headers: {
          accept: "text/event-stream",
          cookie: alice.jar.toHeader(),
          origin: server.baseUrl,
        },
        signal: ac2.signal,
      },
    );
    expect(stalledRes.status).toBe(200);
    const reader2 = stalledRes.body!.getReader();

    const stalledTitles: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const title = `Stalled Task ${i}`;
      stalledTitles.push(title);
      const res = await server.apiRequest(`/api/v1/projects/${project.id}/tasks`, {
        method: "POST",
        jar: alice.jar,
        json: { title },
      });
      expect(res.status).toBe(201);
      if (i === 1) {
        // Give poll loop one tick to enqueue first change and fill maxBufferedBytes (256 B)
        await new Promise((r) => setTimeout(r, 80));
      }
    }
    // Leave reader2 unread past maxBackpressureMs (400ms) so server closes stalled stream
    await new Promise((r) => setTimeout(r, 600));

    let acc2 = "";
    while (true) {
      const { value, done } = await reader2.read();
      if (done) break;
      acc2 += decoder.decode(value, { stream: true });
    }
    const frames2 = parseChunks(acc2);
    const bufferedChanges = frames2.filter((f) => f.event === "change");
    expect(bufferedChanges.length).toBeLessThan(stalledTitles.length);
    const lastCursor2 = frames2[frames2.length - 1]!.id!;
    expect(lastCursor2).toBeTruthy();

    // Reconnecting with Last-Event-ID recovers remaining stalled tasks cleanly
    const resumedSse = await connectSseClient(
      `${server.baseUrl}/api/v1/workspaces/${wksId}/events`,
      { jar: alice.jar, lastEventId: lastCursor2 },
    );
    await resumedSse.stream.waitForFrame(
      (f) =>
        f.event === "change" &&
        (f.data as RealtimeChangeEventDto).task?.title === "Stalled Task 10",
      "recovered stalled backlog through Stalled Task 10",
    );
    resumedSse.stream.close();
  }, 25_000);
});
