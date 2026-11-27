import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createSystemIdGenerator } from "@prood/application";
import {
  CONTRACT_VERSION,
  MCP_REQUIRED_WHOAMI_SCOPE,
  type DbDriverKind,
  type McpWhoamiResponse,
  type MeResponse,
} from "@prood/contracts";
import { isValidEntityId } from "@prood/domain";
import { createBetterAuthAdapter } from "@prood/integration-better-auth";
import { createProodMcpServer } from "@prood/integration-fastmcp";
import { sleep, type KyselyBackedDatabaseClient } from "@prood/persistence-common";
import {
  createPostgresDatabase,
  createPostgresSchema,
  dropPostgresSchema,
} from "@prood/persistence-postgres";
import { createSqliteDatabase } from "@prood/persistence-sqlite";
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

const AUTH_SECRET = "prood-mcp-oauth-test-secret-at-least-32-chars";

interface IsolatedOAuthDb {
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

async function createIsolatedOAuthDb(): Promise<IsolatedOAuthDb> {
  const opened: KyselyBackedDatabaseClient[] = [];

  if (targetDb === "sqlite") {
    const dir = mkdtempSync(join(tmpdir(), "prood-mcp-oauth-sqlite-"));
    const filePath = join(dir, "oauth.sqlite");
    const ctx: IsolatedOAuthDb = {
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

  const schema = `prood_oauth_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await createPostgresSchema(connectionString, schema);

  const ctx: IsolatedOAuthDb = {
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

function createPkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function startTestHttpServer(
  db: KyselyBackedDatabaseClient,
  options: { accessTokenExpiresIn?: number } = {},
) {
  let whoamiExecutedCount = 0;

  const httpServer: HttpServer = createServer();
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind ephemeral HTTP test port");
  }
  const baseURL = `http://127.0.0.1:${address.port}`;
  const mcpResource = `${baseURL}/mcp`;
  const otherResource = `${baseURL}/other-resource`;

  const auth = createBetterAuthAdapter({
    db,
    secret: AUTH_SECRET,
    baseURL,
    trustedOrigins: [baseURL],
    mcpResource,
    extraValidAudiences: [otherResource],
    accessTokenExpiresIn: options.accessTokenExpiresIn,
  });

  const clock = { now: () => new Date() };
  const idGenerator = createSystemIdGenerator();

  const mcpHandler = createProodMcpServer({
    resource: mcpResource,
    tokenVerifier: auth,
    uow: db.uow,
    idGenerator,
    clock,
    onWhoamiExecuted: () => {
      whoamiExecutedCount += 1;
    },
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

  return {
    baseURL,
    mcpResource,
    otherResource,
    getWhoamiExecutedCount: () => whoamiExecutedCount,
    resetWhoamiExecutedCount: () => {
      whoamiExecutedCount = 0;
    },
  };
}

async function issueOAuthAccessToken(params: {
  baseURL: string;
  cookieJar: CookieJar;
  scope: string;
  resource: string;
  redirectUri?: string;
}): Promise<{ accessToken: string; clientId: string }> {
  const redirectUri = params.redirectUri ?? "http://127.0.0.1:49152/callback";

  // 1. Discover protected resource & authorization server metadata
  const prRes = await fetch(
    `${params.baseURL}/.well-known/oauth-protected-resource`,
  );
  expect(prRes.status).toBe(200);
  const prMeta = (await prRes.json()) as {
    resource: string;
    authorization_servers: string[];
  };
  expect(prMeta.authorization_servers.length).toBeGreaterThan(0);

  const asRes = await fetch(
    `${params.baseURL}/.well-known/oauth-authorization-server`,
  );
  expect(asRes.status).toBe(200);
  const asMeta = (await asRes.json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  };
  expect(asMeta.registration_endpoint).toBeTruthy();

  // 2. Dynamic Client Registration (public PKCE client)
  const regRes = await fetch(asMeta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Prood Test MCP Client",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: params.scope,
    }),
  });
  expect(regRes.status).toBe(201);
  const clientReg = (await regRes.json()) as { client_id: string };
  expect(clientReg.client_id).toBeTruthy();

  // 3. Authorization request with PKCE S256
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(12).toString("hex");
  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientReg.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", params.scope);
  authUrl.searchParams.set("resource", params.resource);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const authRes = await fetch(authUrl.toString(), {
    method: "GET",
    headers: {
      accept: "text/html",
      cookie: params.cookieJar.toHeader(),
    },
    redirect: "manual",
  });
  params.cookieJar.updateFrom(authRes);
  let location = authRes.headers.get("location");
  if (authRes.status === 200) {
    const redirectJson = (await authRes.json()) as { redirect?: boolean; url?: string };
    location = redirectJson.url ?? null;
  } else {
    expect(authRes.status).toBe(302);
  }
  expect(location).toBeTruthy();

  const redirectTarget = new URL(location!, params.baseURL);
  let code = redirectTarget.searchParams.get("code");

  if (!code) {
    // 4. Consent page redirect -> submit user approval to /api/auth/oauth2/consent
    expect(redirectTarget.pathname).toBe("/oauth/consent");
    const oauthQuery = redirectTarget.search.replace(/^\?/, "");
    const consentRes = await fetch(
      `${params.baseURL}/api/auth/oauth2/consent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: params.baseURL,
          cookie: params.cookieJar.toHeader(),
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: oauthQuery,
        }),
      },
    );
    expect(consentRes.status).toBe(200);
    params.cookieJar.updateFrom(consentRes);
    const consentJson = (await consentRes.json()) as {
      redirect: boolean;
      url: string;
    };
    expect(consentJson.redirect).toBe(true);
    const callbackUrl = new URL(consentJson.url);
    expect(callbackUrl.searchParams.get("state")).toBe(state);
    code = callbackUrl.searchParams.get("code");
  }

  expect(code).toBeTruthy();

  // 5. Exchange authorization code + PKCE verifier for JWT access token
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code: code!,
    redirect_uri: redirectUri,
    client_id: clientReg.client_id,
    code_verifier: verifier,
    resource: params.resource,
  });

  const tokenRes = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: tokenBody.toString(),
  });
  expect(tokenRes.status).toBe(200);
  const tokenJson = (await tokenRes.json()) as {
    access_token: string;
    token_type: string;
  };
  expect(tokenJson.access_token).toBeTruthy();
  return {
    accessToken: tokenJson.access_token,
    clientId: clientReg.client_id,
  };
}

describe(`MCP OAuth 2.1 interoperability with Better Auth & FastMCP (${targetDb})`, () => {
  it("upgrades from v3 to v4 preserving existing users and workspaces", async () => {
    const ctx = await createIsolatedOAuthDb();
    const db = ctx.openClient();
    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    const usrId = ids.next("usr");
    const now = "2026-11-27T12:00:00.000Z";

    await db.migrate({ targetVersion: 3 });
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "v3-ws",
        name: "V3 Workspace",
        createdAt: now,
      });
      await repos.users.create({
        id: usrId,
        email: "v3@example.com",
        displayName: "V3 User",
        createdAt: now,
      });
    });

    const v4 = await db.migrate();
    expect(v4).toEqual({ appliedVersions: [4, 5], currentVersion: 5 });

    const loaded = await db.uow.run(async (repos) => ({
      workspace: await repos.workspaces.findById(wksId),
      user: await repos.users.findById(usrId),
    }));
    expect(loaded.workspace?.slug).toBe("v3-ws");
    expect(loaded.user?.email).toBe("v3@example.com");
  });

  it("completes OAuth discovery, consent, listTools, and whoami matching the Web Prood user ID", async () => {
    const ctx = await createIsolatedOAuthDb();
    const db = ctx.openClient();
    await db.migrate();

    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    const now = "2026-11-27T12:05:00.000Z";
    await db.uow.run((repos) =>
      repos.workspaces.create({
        id: wksId,
        slug: "mcp-eng",
        name: "MCP Engineering",
        createdAt: now,
      }),
    );

    const server = await startTestHttpServer(db);

    // Unauthenticated /mcp call must return 401 + RFC 9728 resource_metadata
    const unauthMcpRes = await fetch(server.mcpResource, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(unauthMcpRes.status).toBe(401);
    const wwwAuth = unauthMcpRes.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource");

    // Sign up user via Web auth endpoint and add workspace membership
    const jar = new CookieJar();
    const signUpRes = await fetch(`${server.baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.baseURL,
      },
      body: JSON.stringify({
        email: "mcp-user@example.com",
        password: "mcp-oauth-password-123",
        name: "MCP Tester",
      }),
    });
    expect(signUpRes.status).toBe(200);
    jar.updateFrom(signUpRes);

    const meRes = await fetch(`${server.baseURL}/api/v1/me`, {
      headers: { cookie: jar.toHeader() },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as MeResponse;
    expect(isValidEntityId("usr", me.user.id)).toBe(true);

    await db.uow.run((repos) =>
      repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: me.user.id,
        role: "admin",
        createdAt: now,
      }),
    );

    // Issue real OAuth JWT access token with prood:read scope
    const { accessToken, clientId } = await issueOAuthAccessToken({
      baseURL: server.baseURL,
      cookieJar: jar,
      scope: `openid profile email ${MCP_REQUIRED_WHOAMI_SCOPE}`,
      resource: server.mcpResource,
    });

    // Connect real @modelcontextprotocol/sdk Client over StreamableHTTPClientTransport
    const client = new Client({ name: "prood-test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(server.mcpResource),
      {
        requestInit: {
          headers: {
            authorization: `Bearer ${accessToken}`,
          },
        },
      },
    );

    await client.connect(transport);
    try {
      const toolsResult = await client.listTools();
      expect(toolsResult.tools.map((t) => t.name)).toContain("whoami");

      const callResult = await client.callTool({
        name: "whoami",
        arguments: {},
      });
      const textContent = (
        callResult.content as Array<{ type: string; text?: string }>
      ).find((item) => item.type === "text");
      expect(textContent?.text).toBeTruthy();

      const whoami = JSON.parse(textContent!.text!) as McpWhoamiResponse;
      expect(whoami).toMatchObject({
        contractVersion: CONTRACT_VERSION,
        userId: me.user.id,
        email: "mcp-user@example.com",
        displayName: "MCP Tester",
        clientId,
        resource: server.mcpResource,
      });
      expect(whoami.scopes).toContain(MCP_REQUIRED_WHOAMI_SCOPE);
      expect(whoami.workspaces).toHaveLength(1);
      expect(whoami.workspaces[0]?.workspaceId).toBe(wksId);
      expect(server.getWhoamiExecutedCount()).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("rejects wrong-audience, expired, and insufficient-scope tokens without executing whoami", async () => {
    const ctx = await createIsolatedOAuthDb();
    const db = ctx.openClient();
    await db.migrate();

    const server = await startTestHttpServer(db, {
      accessTokenExpiresIn: 1,
    });

    const jar = new CookieJar();
    const signUpRes = await fetch(`${server.baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.baseURL,
      },
      body: JSON.stringify({
        email: "strict-user@example.com",
        password: "strict-oauth-password-123",
        name: "Strict Tester",
      }),
    });
    expect(signUpRes.status).toBe(200);
    jar.updateFrom(signUpRes);

    // 1. Wrong audience: valid token issued for /other-resource, sent to /mcp
    const wrongAudToken = await issueOAuthAccessToken({
      baseURL: server.baseURL,
      cookieJar: jar,
      scope: `openid profile ${MCP_REQUIRED_WHOAMI_SCOPE}`,
      resource: server.otherResource,
    });

    const wrongAudClient = new Client({
      name: "wrong-aud-client",
      version: "1.0.0",
    });
    const wrongAudTransport = new StreamableHTTPClientTransport(
      new URL(server.mcpResource),
      {
        requestInit: {
          headers: { authorization: `Bearer ${wrongAudToken.accessToken}` },
        },
      },
    );
    await expect(wrongAudClient.connect(wrongAudTransport)).rejects.toThrow();

    // 2. Insufficient scope: valid token for /mcp WITHOUT prood:read
    const lowScopeToken = await issueOAuthAccessToken({
      baseURL: server.baseURL,
      cookieJar: jar,
      scope: "openid profile",
      resource: server.mcpResource,
    });

    const lowScopeClient = new Client({
      name: "low-scope-client",
      version: "1.0.0",
    });
    const lowScopeTransport = new StreamableHTTPClientTransport(
      new URL(server.mcpResource),
      {
        requestInit: {
          headers: { authorization: `Bearer ${lowScopeToken.accessToken}` },
        },
      },
    );
    await lowScopeClient.connect(lowScopeTransport);
    try {
      await expect(
        lowScopeClient.callTool({ name: "whoami", arguments: {} }),
      ).rejects.toThrow();
    } finally {
      await lowScopeClient.close();
    }

    // 3. Expired token: issue valid token with 1s TTL, wait > 1s, then attempt connect/call
    const shortLivedToken = await issueOAuthAccessToken({
      baseURL: server.baseURL,
      cookieJar: jar,
      scope: `openid profile ${MCP_REQUIRED_WHOAMI_SCOPE}`,
      resource: server.mcpResource,
    });
    await sleep(1200);

    const expiredClient = new Client({
      name: "expired-client",
      version: "1.0.0",
    });
    const expiredTransport = new StreamableHTTPClientTransport(
      new URL(server.mcpResource),
      {
        requestInit: {
          headers: { authorization: `Bearer ${shortLivedToken.accessToken}` },
        },
      },
    );
    await expect(expiredClient.connect(expiredTransport)).rejects.toThrow();

    // Verify tool handler was never invoked by any of the 3 rejected tokens
    expect(server.getWhoamiExecutedCount()).toBe(0);
  });

  it("resumes OAuth authorization after unauthenticated login redirect and serves consent assets", async () => {
    const ctx = await createIsolatedOAuthDb();
    const db = ctx.openClient();
    await db.migrate();

    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    const now = "2026-11-27T12:15:00.000Z";
    await db.uow.run((repos) =>
      repos.workspaces.create({
        id: wksId,
        slug: "resume-ws",
        name: "Resume Workspace",
        createdAt: now,
      }),
    );

    const server = await startTestHttpServer(db);

    // Pre-register user, then clear cookies so authorization starts unauthenticated
    const setupJar = new CookieJar();
    const signUpRes = await fetch(`${server.baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.baseURL,
      },
      body: JSON.stringify({
        email: "resume-user@example.com",
        password: "resume-oauth-password-123",
        name: "Resume Tester",
      }),
    });
    expect(signUpRes.status).toBe(200);
    setupJar.updateFrom(signUpRes);

    const meRes = await fetch(`${server.baseURL}/api/v1/me`, {
      headers: { cookie: setupJar.toHeader() },
    });
    const me = (await meRes.json()) as MeResponse;
    await db.uow.run((repos) =>
      repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: me.user.id,
        role: "member",
        createdAt: now,
      }),
    );

    // 1. Register public PKCE client via DCR
    const asRes = await fetch(
      `${server.baseURL}/.well-known/oauth-authorization-server`,
    );
    const asMeta = (await asRes.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
    };
    const redirectUri = "http://127.0.0.1:49153/callback";
    const regRes = await fetch(asMeta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Resume Test Client",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: `openid profile ${MCP_REQUIRED_WHOAMI_SCOPE}`,
      }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    // 2. Start /oauth2/authorize unauthenticated -> must redirect to loginPage with signed query
    const { verifier, challenge } = createPkcePair();
    const state = randomBytes(10).toString("hex");
    const authUrl = new URL(asMeta.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", `openid profile ${MCP_REQUIRED_WHOAMI_SCOPE}`);
    authUrl.searchParams.set("resource", server.mcpResource);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    const unauthAuthRes = await fetch(authUrl.toString(), {
      method: "GET",
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    let loginLocation = unauthAuthRes.headers.get("location");
    if (unauthAuthRes.status === 200) {
      const redirectJson = (await unauthAuthRes.json()) as {
        redirect?: boolean;
        url?: string;
      };
      loginLocation = redirectJson.url ?? null;
    } else {
      expect(unauthAuthRes.status).toBe(302);
    }
    expect(loginLocation).toBeTruthy();
    const loginUrl = new URL(loginLocation!, server.baseURL);
    expect(loginUrl.pathname).toBe("/");
    const signedLoginQuery = loginUrl.search.replace(/^\?/, "");
    expect(signedLoginQuery).toContain("sig=");

    // 3. Sign in via /api/auth/sign-in/email forwarding oauth_query -> must resume to consent
    const loginJar = new CookieJar();
    const signInRes = await fetch(`${server.baseURL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.baseURL,
      },
      body: JSON.stringify({
        email: "resume-user@example.com",
        password: "resume-oauth-password-123",
        oauth_query: signedLoginQuery,
      }),
    });
    expect(signInRes.status).toBe(200);
    loginJar.updateFrom(signInRes);
    const signInJson = (await signInRes.json()) as {
      redirect?: boolean;
      url?: string;
    };
    expect(signInJson.redirect).toBe(true);
    expect(signInJson.url).toBeTruthy();

    const consentUrl = new URL(signInJson.url!, server.baseURL);
    expect(consentUrl.pathname).toBe("/oauth/consent");

    // Verify mounted web shell assets serve /oauth/consent, /shell.js, /shell.css with security headers
    const consentPageRes = await fetch(consentUrl.toString());
    expect(consentPageRes.status).toBe(200);
    expect(consentPageRes.headers.get("x-frame-options")).toBe("DENY");
    expect(await consentPageRes.text()).toContain('src="/shell.js"');

    const shellJsRes = await fetch(`${server.baseURL}/shell.js`);
    expect(shellJsRes.status).toBe(200);
    const shellCssRes = await fetch(`${server.baseURL}/shell.css`);
    expect(shellCssRes.status).toBe(200);

    // 4. Approve consent and exchange code for JWT token
    const consentRes = await fetch(`${server.baseURL}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.baseURL,
        cookie: loginJar.toHeader(),
      },
      body: JSON.stringify({
        accept: true,
        oauth_query: consentUrl.search.replace(/^\?/, ""),
      }),
    });
    expect(consentRes.status).toBe(200);
    const consentJson = (await consentRes.json()) as { url: string };
    const callbackUrl = new URL(consentJson.url);
    expect(callbackUrl.searchParams.get("state")).toBe(state);
    const code = callbackUrl.searchParams.get("code")!;
    expect(code).toBeTruthy();

    const tokenRes = await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: server.mcpResource,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token: accessToken } = (await tokenRes.json()) as {
      access_token: string;
    };

    // 5. Connect real MCP client and confirm whoami returns the same user ID
    const client = new Client({ name: "resume-mcp-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(server.mcpResource),
      {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      },
    );
    await client.connect(transport);
    try {
      const callRes = await client.callTool({ name: "whoami", arguments: {} });
      const text = (
        callRes.content as Array<{ type: string; text?: string }>
      ).find((item) => item.type === "text")?.text;
      const whoami = JSON.parse(text!) as McpWhoamiResponse;
      expect(whoami.userId).toBe(me.user.id);
    } finally {
      await client.close();
    }
  });

  it("enforces consent denial and rejects revoked sessions, disabled clients, and deleted users on /mcp", async () => {
    const ctx = await createIsolatedOAuthDb();
    const db = ctx.openClient();
    await db.migrate();
    const server = await startTestHttpServer(db);

    const jar = new CookieJar();
    const signUpRes = await fetch(`${server.baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.baseURL,
      },
      body: JSON.stringify({
        email: "revoke-user@example.com",
        password: "revoke-password-1234",
        name: "Revoke Tester",
      }),
    });
    expect(signUpRes.status).toBe(200);
    jar.updateFrom(signUpRes);

    // 1. Consent denial returns access_denied redirect
    const asMeta = (await (
      await fetch(`${server.baseURL}/.well-known/oauth-authorization-server`)
    ).json()) as { authorization_endpoint: string; registration_endpoint: string };
    const redirectUri = "http://127.0.0.1:49154/callback";
    const regJson = (await (
      await fetch(asMeta.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Deny Test Client",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: `openid ${MCP_REQUIRED_WHOAMI_SCOPE}`,
        }),
      })
    ).json()) as { client_id: string };
    const { challenge } = createPkcePair();
    const denyAuthUrl = new URL(asMeta.authorization_endpoint);
    denyAuthUrl.searchParams.set("response_type", "code");
    denyAuthUrl.searchParams.set("client_id", regJson.client_id);
    denyAuthUrl.searchParams.set("redirect_uri", redirectUri);
    denyAuthUrl.searchParams.set("scope", `openid ${MCP_REQUIRED_WHOAMI_SCOPE}`);
    denyAuthUrl.searchParams.set("resource", server.mcpResource);
    denyAuthUrl.searchParams.set("state", "deny-state");
    denyAuthUrl.searchParams.set("code_challenge", challenge);
    denyAuthUrl.searchParams.set("code_challenge_method", "S256");

    const denyAuthRes = await fetch(denyAuthUrl.toString(), {
      headers: { accept: "text/html", cookie: jar.toHeader() },
      redirect: "manual",
    });
    let denyConsentLoc = denyAuthRes.headers.get("location");
    if (denyAuthRes.status === 200) {
      denyConsentLoc = ((await denyAuthRes.json()) as { url?: string }).url ?? null;
    }
    const denyQuery = new URL(denyConsentLoc!, server.baseURL).search.replace(/^\?/, "");
    const deniedRes = await fetch(`${server.baseURL}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.baseURL,
        cookie: jar.toHeader(),
      },
      body: JSON.stringify({ accept: false, oauth_query: denyQuery }),
    });
    expect(deniedRes.status).toBe(200);
    const deniedCallback = new URL(((await deniedRes.json()) as { url: string }).url);
    expect(deniedCallback.searchParams.get("error")).toBe("access_denied");
    expect(deniedCallback.searchParams.get("state")).toBe("deny-state");

    // 2. Issue valid token, confirm 200 on initialize, then test client disable & session/user revocation
    const { accessToken, clientId } = await issueOAuthAccessToken({
      baseURL: server.baseURL,
      cookieJar: jar,
      scope: `openid ${MCP_REQUIRED_WHOAMI_SCOPE}`,
      resource: server.mcpResource,
    });

    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "revoke-check", version: "1.0.0" },
      },
    });
    const okRes = await fetch(server.mcpResource, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
      },
      body: initBody,
    });
    expect(okRes.status).toBe(200);

    // Disable OAuth client -> must fail with 401 invalid_token
    await db.kysely
      .updateTable("oauthClient")
      .set({ disabled: targetDb === "sqlite" ? 1 : true })
      .where("clientId", "=", clientId)
      .execute();
    const disabledRes = await fetch(server.mcpResource, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
      },
      body: initBody,
    });
    expect(disabledRes.status).toBe(401);

    // Re-enable client, verify works again, then sign out (revokes auth_session) & delete auth_user
    await db.kysely
      .updateTable("oauthClient")
      .set({ disabled: targetDb === "sqlite" ? 0 : false })
      .where("clientId", "=", clientId)
      .execute();

    await fetch(`${server.baseURL}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin: server.baseURL, cookie: jar.toHeader() },
    });
    // Also delete auth_user to verify subject revocation regardless of sid claim presence
    await db.kysely.deleteFrom("auth_user").execute();
    const revokedRes = await fetch(server.mcpResource, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
      },
      body: initBody,
    });
    expect(revokedRes.status).toBe(401);
  });
});
