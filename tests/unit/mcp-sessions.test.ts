import { describe, expect, it } from "vitest";
import type { McpTokenVerifier, UnitOfWork } from "@prood/application";
import { MCP_REQUIRED_WHOAMI_SCOPE } from "@prood/contracts";
import { createProodMcpServer } from "@prood/integration-fastmcp";

function createTestDeps(nowMsRef: { value: number }) {
  const tokenVerifier: McpTokenVerifier = {
    async verifyBearerToken(headers) {
      const authHeader = headers.get("authorization");
      const tokenPresets: Record<
        string,
        { subject: string; clientId: string; scopes: string[] }
      > = {
        "Bearer valid": {
          subject: "ba_sub_1",
          clientId: "client_1",
          scopes: [MCP_REQUIRED_WHOAMI_SCOPE],
        },
        "Bearer limited": {
          subject: "ba_sub_1",
          clientId: "client_1",
          scopes: ["openid"],
        },
        "Bearer other-user": {
          subject: "ba_sub_2",
          clientId: "client_1",
          scopes: [MCP_REQUIRED_WHOAMI_SCOPE],
        },
        "Bearer other-client": {
          subject: "ba_sub_1",
          clientId: "client_2",
          scopes: [MCP_REQUIRED_WHOAMI_SCOPE],
        },
      };
      const preset = (authHeader ? tokenPresets[authHeader] : undefined) ?? {
        subject: "ba_sub_1",
        clientId: "client_1",
        scopes: [MCP_REQUIRED_WHOAMI_SCOPE],
      };
      return {
        ok: true,
        token: {
          subject: preset.subject,
          clientId: preset.clientId,
          scopes: preset.scopes,
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
  authHeader = "Bearer valid",
): Promise<string> {
  const res = await handler.handleRequest(
    new Request("http://127.0.0.1:3000/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: authHeader,
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

  it("blocks cross-user and cross-client session access and preserves session state on rejected scope call", async () => {
    const nowMs = { value: 1_795_000_000_000 };
    const authFailures: Array<{ path: string; reasonCode: string }> = [];
    const handler = createProodMcpServer({
      ...createTestDeps(nowMs),
      sessionIdleTtlMs: 5_000,
      onAuthFailure: (info) => {
        authFailures.push({ path: info.path, reasonCode: info.reasonCode });
      },
    });

    const ownerSession = await initializeMcpSession(handler, "Bearer valid");

    // Cross-user POST, GET, DELETE must all be rejected with 403 and must not close ownerSession
    for (const method of ["POST", "GET", "DELETE"] as const) {
      const res = await handler.handleRequest(
        new Request("http://127.0.0.1:3000/mcp", {
          method,
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: "Bearer other-user",
            "mcp-session-id": ownerSession,
          },
          body:
            method === "POST"
              ? JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/list", params: {} })
              : undefined,
        }),
      );
      expect(res.status).toBe(403);
    }

    // Cross-client POST must also be rejected with 403
    const crossClientRes = await handler.handleRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer other-client",
          "mcp-session-id": ownerSession,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/list", params: {} }),
      }),
    );
    expect(crossClientRes.status).toBe(403);

    // Owner advances near TTL; a rejected 403 insufficient-scope call must NOT refresh lastActivityAtMs
    nowMs.value += 4_500;
    const limitedCall = await handler.handleRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer limited",
          "mcp-session-id": ownerSession,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 22,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        }),
      }),
    );
    expect(limitedCall.status).toBe(403);
    expect(limitedCall.headers.get("www-authenticate")).toContain("insufficient_scope");

    // 600ms later (total 5_100ms since init): session must expire because 403 call did not refresh TTL
    nowMs.value += 600;
    expect((await listToolsInSession(handler, ownerSession)).status).toBe(404);

    // Every rejected POST, GET, DELETE principal mismatch + scope error was audited via onAuthFailure
    expect(
      authFailures.filter((f) => f.reasonCode === "SESSION_PRINCIPAL_MISMATCH"),
    ).toHaveLength(4);
    expect(
      authFailures.filter((f) => f.reasonCode === "INSUFFICIENT_SCOPE"),
    ).toHaveLength(1);
  });

  it("enforces per-principal session cap, Origin header allowlist, DELETE cleanup, and header sanitization", async () => {
    const nowMs = { value: 1_795_000_000_000 };
    const handler = createProodMcpServer({
      resource: "http://127.0.0.1:3000/mcp",
      tokenVerifier: {
        async verifyBearerToken(headers) {
          const authHeader = headers.get("authorization");
          if (authHeader === "Bearer multiline-fail") {
            return {
              ok: false,
              status: 401,
              error: "invalid_token",
              description: "bad\r\nheader \"value\"",
            };
          }
          return {
            ok: true,
            token: {
              subject: authHeader === "Bearer victim" ? "ba_victim" : "ba_spammer",
              clientId: "client_1",
              scopes: [MCP_REQUIRED_WHOAMI_SCOPE],
              audience: "http://127.0.0.1:3000/mcp",
              expiresAt: Math.floor((nowMs.value + 3_600_000) / 1000),
              issuer: "http://127.0.0.1:3000/api/auth",
            },
          };
        },
        getProtectedResourceMetadata: () => ({}),
        getAuthorizationServerMetadata: async () => ({}),
      },
      uow: { run: async () => null } as unknown as UnitOfWork,
      idGenerator: { next: () => "usr_01jf8x9z2k3m4n5p6q7r8s9t0v" as never },
      clock: { now: () => new Date(nowMs.value) },
      maxActiveSessions: 5,
      maxSessionsPerPrincipal: 2,
      trustedOrigins: ["http://127.0.0.1:3000"],
    });

    // Rejects untrusted Origin with 403
    const evilOriginRes = await handler.handleRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          authorization: "Bearer victim",
        },
        body: "{}",
      }),
    );
    expect(evilOriginRes.status).toBe(403);

    // Multi-line WWW-Authenticate description is sanitized without throwing TypeError
    const sanitizedRes = await handler.handleRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer multiline-fail",
        },
        body: "{}",
      }),
    );
    expect(sanitizedRes.status).toBe(401);
    expect(sanitizedRes.headers.get("www-authenticate")).not.toMatch(/[\r\n]/);

    // Victim opens 1 session; spammer opens 3 sessions -> per-principal cap evicts spammer's own oldest, NOT victim's
    const victimSession = await initializeMcpSession(handler, "Bearer victim");
    nowMs.value += 10;
    const spam1 = await initializeMcpSession(handler, "Bearer spammer");
    nowMs.value += 10;
    const spam2 = await initializeMcpSession(handler, "Bearer spammer");
    nowMs.value += 10;
    const spam3 = await initializeMcpSession(handler, "Bearer spammer");

    expect((await listToolsInSession(handler, spam1)).status).toBe(404);
    expect((await listToolsInSession(handler, spam2)).status).toBe(200);
    expect((await listToolsInSession(handler, spam3)).status).toBe(200);

    // Victim's session must still be alive
    const victimCheck = await handler.handleRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer victim",
          "mcp-session-id": victimSession,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 30, method: "tools/list", params: {} }),
      }),
    );
    expect(victimCheck.status).toBe(200);

    // DELETE cleans up session and subsequent access returns 404
    const delRes = await handler.handleRequest(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "DELETE",
        headers: {
          authorization: "Bearer victim",
          "mcp-session-id": victimSession,
        },
      }),
    );
    expect(delRes.status).toBe(204);
    expect((await listToolsInSession(handler, victimSession)).status).toBe(404);

    await handler.close?.();
  });

  it("rejects create_task and start_task with 403 insufficient_scope when token only has prood:read and does not refresh session TTL", async () => {
    const nowMs = { value: 1_795_000_000_000 };
    const authFailures: Array<{ path: string; reasonCode: string }> = [];
    const handler = createProodMcpServer({
      ...createTestDeps(nowMs),
      sessionIdleTtlMs: 5_000,
      onAuthFailure: (info) => {
        authFailures.push({ path: info.path, reasonCode: info.reasonCode });
      },
    });

    const sessionId = await initializeMcpSession(handler, "Bearer valid");
    nowMs.value += 4_500;

    for (const toolCall of [
      {
        id: 40,
        name: "create_task",
        arguments: {
          projectRef: "PRD",
          title: "Blocked write",
          idempotencyKey: "k-read-only",
        },
      },
      {
        id: 41,
        name: "start_task",
        arguments: {
          taskRef: "PRD-1",
        },
      },
    ]) {
      const writeRes = await handler.handleRequest(
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
            id: toolCall.id,
            method: "tools/call",
            params: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          }),
        }),
      );

      expect(writeRes.status).toBe(403);
      expect(writeRes.headers.get("www-authenticate")).toContain("insufficient_scope");
      expect(writeRes.headers.get("www-authenticate")).toContain("prood:write");
    }
    expect(
      authFailures.filter((entry) => entry.reasonCode === "INSUFFICIENT_SCOPE"),
    ).toHaveLength(2);

    nowMs.value += 600;
    expect((await listToolsInSession(handler, sessionId)).status).toBe(404);

    await handler.close?.();
  });
});
