import { describe, expect, it } from "vitest";
import type { McpTokenVerifier, UnitOfWork } from "@prood/application";
import { MCP_REQUIRED_WHOAMI_SCOPE } from "@prood/contracts";
import { createProodMcpServer } from "@prood/integration-fastmcp";

function createTestDeps(nowMsRef: { value: number }) {
  const tokenVerifier: McpTokenVerifier = {
    async verifyBearerToken(headers) {
      const authHeader = headers.get("authorization");
      const scopes =
        authHeader === "Bearer limited"
          ? ["openid"]
          : [MCP_REQUIRED_WHOAMI_SCOPE];
      return {
        ok: true,
        token: {
          subject: "ba_sub_1",
          clientId: "client_1",
          scopes,
          audience: "http://127.0.0.1:3000/mcp",
          expiresAt: Math.floor((nowMsRef.value + 3_600_000) / 1000),
          issuer: "http://127.0.0.1:3000/api/auth",
        },
      };
    },
    getProtectedResourceMetadata: () => ({}),
    getAuthorizationServerMetadata: async () => ({}),
  };

  const uow = {
    run: async () => null,
  } as unknown as UnitOfWork;

  return {
    resource: "http://127.0.0.1:3000/mcp",
    tokenVerifier,
    uow,
    idGenerator: { next: () => "usr_01jf8x9z2k3m4n5p6q7r8s9t0v" as never },
    clock: { now: () => new Date(nowMsRef.value) },
  };
}

async function initializeMcpSession(
  handler: ReturnType<typeof createProodMcpServer>,
): Promise<string> {
  const res = await handler.handleRequest(
    new Request("http://127.0.0.1:3000/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer valid",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    }),
  );
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function listToolsInSession(
  handler: ReturnType<typeof createProodMcpServer>,
  sessionId: string,
): Promise<Response> {
  return handler.handleRequest(
    new Request("http://127.0.0.1:3000/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer valid",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    }),
  );
}

describe("@prood/integration-fastmcp bounded session retention", () => {
  it("expires idle sessions after sessionIdleTtlMs", async () => {
    const nowMs = { value: 1_795_000_000_000 };
    const handler = createProodMcpServer({
      ...createTestDeps(nowMs),
      sessionIdleTtlMs: 5_000,
    });

    const sessionId = await initializeMcpSession(handler);

    nowMs.value += 2_000;
    expect((await listToolsInSession(handler, sessionId)).status).toBe(200);

    // Advance past idle TTL from last activity (2_000 + 5_001)
    nowMs.value += 5_001;
    const expiredRes = await listToolsInSession(handler, sessionId);
    expect(expiredRes.status).toBe(404);
  });

  it("evicts the least recently used session when maxActiveSessions is exceeded", async () => {
    const nowMs = { value: 1_795_000_000_000 };
    const handler = createProodMcpServer({
      ...createTestDeps(nowMs),
      maxActiveSessions: 2,
    });

    const session1 = await initializeMcpSession(handler);
    nowMs.value += 10;
    const session2 = await initializeMcpSession(handler);

    // Touch session 1 so session 2 becomes the least recently used
    nowMs.value += 10;
    expect((await listToolsInSession(handler, session1)).status).toBe(200);

    // Initializing session 3 must evict session 2, keeping session 1 and session 3
    nowMs.value += 10;
    const session3 = await initializeMcpSession(handler);

    expect((await listToolsInSession(handler, session2)).status).toBe(404);
    expect((await listToolsInSession(handler, session1)).status).toBe(200);
    expect((await listToolsInSession(handler, session3)).status).toBe(200);
  });

  it("does not evict active sessions when a sessionless POST is rejected", async () => {
    const nowMs = { value: 1_795_000_000_000 };
    const handler = createProodMcpServer({
      ...createTestDeps(nowMs),
      maxActiveSessions: 2,
    });

    const session1 = await initializeMcpSession(handler);
    nowMs.value += 10;
    const session2 = await initializeMcpSession(handler);

    // Rejected by scope check (403) before transport.handleRequest
    nowMs.value += 10;
    const forbiddenRes = await handler.handleRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer limited",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        }),
      }),
    );
    expect(forbiddenRes.status).toBe(403);
    expect(forbiddenRes.headers.get("www-authenticate")).toContain(
      "insufficient_scope",
    );

    // Rejected by transport as non-initialize request without mcp-session-id (400)
    nowMs.value += 10;
    const badReqRes = await handler.handleRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/list",
          params: {},
        }),
      }),
    );
    expect(badReqRes.status).toBe(400);

    // Both existing sessions must still be active
    expect((await listToolsInSession(handler, session1)).status).toBe(200);
    expect((await listToolsInSession(handler, session2)).status).toBe(200);
  });
});
