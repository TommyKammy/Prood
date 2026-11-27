import { FastMCP, type FastMCPSession } from "fastmcp";
import { WebStreamableHTTPServerTransport } from "fastmcp/edge";
import { z } from "zod";
import {
  createMcpIdentityUseCase,
  type Clock,
  type IdGenerator,
  type McpHttpHandler,
  type McpTokenVerifier,
  type McpVerifiedToken,
  type UnitOfWork,
} from "@prood/application";
import { MCP_REQUIRED_WHOAMI_SCOPE } from "@prood/contracts";

const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 1000;

export interface ProodMcpServerDeps {
  resource: string;
  tokenVerifier: McpTokenVerifier;
  uow: UnitOfWork;
  idGenerator: IdGenerator;
  clock: Clock;
  onWhoamiExecuted?: () => void;
  sessionIdleTtlMs?: number;
  maxActiveSessions?: number;
}

type ProodMcpSessionAuth = McpVerifiedToken & Record<string, unknown>;

interface ActiveSessionEntry {
  transport: WebStreamableHTTPServerTransport;
  session: FastMCPSession<ProodMcpSessionAuth>;
  lastActivityAtMs: number;
  tokenExpiresAtMs: number;
}

function buildUnauthorizedResponse(
  status: 401 | 403,
  error: "invalid_token" | "insufficient_scope",
  description: string,
  resourceMetadataUrl: string,
  requiredScope?: string,
): Response {
  const safeDesc = description.replaceAll('"', "'");
  const parts = [
    `Bearer resource_metadata="${resourceMetadataUrl}"`,
    `error="${error}"`,
    `error_description="${safeDesc}"`,
  ];
  if (requiredScope) {
    parts.push(`scope="${requiredScope}"`);
  }
  return new Response(
    JSON.stringify({
      error,
      error_description: description,
      ...(requiredScope ? { scope: requiredScope } : {}),
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "www-authenticate": parts.join(", "),
      },
    },
  );
}

/**
 * Creates a FastMCP server exposing Prood tools over Web-Standard Streamable HTTP,
 * verifying OAuth bearer tokens, per-tool scopes, and bounded session retention.
 */
export function createProodMcpServer(deps: ProodMcpServerDeps): McpHttpHandler {
  const identityUseCase = createMcpIdentityUseCase({
    uow: deps.uow,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  });

  const sessionIdleTtlMs = Math.max(
    1,
    Math.trunc(deps.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS),
  );
  const maxActiveSessions = Math.max(
    1,
    Math.trunc(deps.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS),
  );

  const resourceUrl = new URL(deps.resource);
  const resourceMetadataUrl = `${resourceUrl.origin}/.well-known/oauth-protected-resource`;

  const server = new FastMCP<ProodMcpSessionAuth>({
    name: "Prood MCP",
    version: "0.0.1",
    // Enables FastMCP's authRequired enforcement for `scopes` checks.
    authenticate: async () => undefined,
  });

  server.addTool({
    name: "whoami",
    description:
      "Return the authenticated Prood user identity and workspace memberships for this OAuth token.",
    parameters: z.object({}),
    scopes: [MCP_REQUIRED_WHOAMI_SCOPE],
    annotations: {
      readOnlyHint: true,
      title: "Who am I",
    },
    execute: async (_args, context) => {
      const sessionAuth = context.session;
      if (
        !sessionAuth ||
        !Array.isArray(sessionAuth.scopes) ||
        !sessionAuth.scopes.includes(MCP_REQUIRED_WHOAMI_SCOPE)
      ) {
        throw new Error(
          `Insufficient scope: ${MCP_REQUIRED_WHOAMI_SCOPE} is required`,
        );
      }

      deps.onWhoamiExecuted?.();
      const profile = await identityUseCase.whoami(sessionAuth, deps.resource);
      return JSON.stringify(profile);
    },
  });

  const activeSessions = new Map<string, ActiveSessionEntry>();

  async function closeSessionEntry(entry: ActiveSessionEntry): Promise<void> {
    await Promise.allSettled([entry.session.close(), entry.transport.close()]);
  }

  function collectEvictions(
    nowMs: number,
    maxAllowed: number,
  ): ActiveSessionEntry[] {
    const evicted: ActiveSessionEntry[] = [];
    for (const [sid, entry] of activeSessions) {
      const idleExpired = nowMs - entry.lastActivityAtMs >= sessionIdleTtlMs;
      const tokenExpired =
        entry.tokenExpiresAtMs > 0 && nowMs >= entry.tokenExpiresAtMs;
      if (idleExpired || tokenExpired) {
        activeSessions.delete(sid);
        evicted.push(entry);
      }
    }
    while (activeSessions.size > maxAllowed) {
      const oldest = activeSessions.entries().next().value;
      if (!oldest) {
        break;
      }
      const [oldestId, oldestEntry] = oldest;
      activeSessions.delete(oldestId);
      evicted.push(oldestEntry);
    }
    return evicted;
  }

  async function evictSessions(
    nowMs: number,
    reserveSlotForNew = false,
  ): Promise<void> {
    const maxAllowed = reserveSlotForNew
      ? Math.max(0, maxActiveSessions - 1)
      : maxActiveSessions;
    const evicted = collectEvictions(nowMs, maxAllowed);
    if (evicted.length > 0) {
      await Promise.allSettled(evicted.map(closeSessionEntry));
    }
  }

  function touchSession(
    sessionId: string,
    entry: ActiveSessionEntry,
    nowMs: number,
    token: McpVerifiedToken,
  ): void {
    entry.lastActivityAtMs = nowMs;
    entry.tokenExpiresAtMs = token.expiresAt > 0 ? token.expiresAt * 1000 : 0;
    activeSessions.delete(sessionId);
    activeSessions.set(sessionId, entry);
  }

  function checkSessionScopes(
    session: FastMCPSession<ProodMcpSessionAuth>,
    parsedBody: unknown,
  ): Response | null {
    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    for (const msg of messages) {
      const challenge = session.scopeChallengeFor(msg);
      if (challenge) {
        const requiredScope = challenge.scopes.join(" ");
        return buildUnauthorizedResponse(
          403,
          "insufficient_scope",
          challenge.description || `Missing required scope: ${requiredScope}`,
          resourceMetadataUrl,
          requiredScope,
        );
      }
    }
    return null;
  }

  return {
    async handleRequest(request: Request): Promise<Response> {
      const nowMs = deps.clock.now().getTime();
      await evictSessions(nowMs);

      const authResult = await deps.tokenVerifier.verifyBearerToken(
        request.headers,
      );
      if (!authResult.ok) {
        return buildUnauthorizedResponse(
          authResult.status,
          authResult.error,
          authResult.description,
          resourceMetadataUrl,
          authResult.requiredScope,
        );
      }

      const sessionAuth: ProodMcpSessionAuth = {
        ...authResult.token,
      };
      const sessionId = request.headers.get("mcp-session-id");

      if (request.method === "POST") {
        let parsedBody: unknown;
        try {
          const text = await request.text();
          parsedBody = text ? JSON.parse(text) : undefined;
        } catch {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32700, message: "Parse error" },
              id: null,
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        if (sessionId) {
          const existing = activeSessions.get(sessionId);
          if (!existing) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32001, message: "Session not found" },
                id: null,
              }),
              { status: 404, headers: { "content-type": "application/json" } },
            );
          }
          touchSession(sessionId, existing, nowMs, authResult.token);
          existing.session.updateAuth(sessionAuth);
          const scopeError = checkSessionScopes(existing.session, parsedBody);
          if (scopeError) {
            return scopeError;
          }
          return existing.transport.handleRequest(request, parsedBody);
        }

        await evictSessions(nowMs, true);

        let connectedSession: FastMCPSession<ProodMcpSessionAuth> | undefined;
        const transport = new WebStreamableHTTPServerTransport({
          sessionIdGenerator: () => globalThis.crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (newSessionId) => {
            const callbackNowMs = deps.clock.now().getTime();
            const overflow = collectEvictions(
              callbackNowMs,
              Math.max(0, maxActiveSessions - 1),
            );
            for (const entry of overflow) {
              void closeSessionEntry(entry);
            }
            if (connectedSession) {
              activeSessions.set(newSessionId, {
                transport,
                session: connectedSession,
                lastActivityAtMs: callbackNowMs,
                tokenExpiresAtMs:
                  authResult.token.expiresAt > 0
                    ? authResult.token.expiresAt * 1000
                    : 0,
              });
            }
          },
          onsessionclosed: (closedSessionId) => {
            activeSessions.delete(closedSessionId);
          },
        });

        connectedSession = await server.connect(transport, sessionAuth);
        const scopeError = checkSessionScopes(connectedSession, parsedBody);
        if (scopeError) {
          await connectedSession.close();
          return scopeError;
        }
        return transport.handleRequest(request, parsedBody);
      }

      if (!sessionId) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Missing mcp-session-id header" },
            id: null,
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const existing = activeSessions.get(sessionId);
      if (!existing) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      touchSession(sessionId, existing, nowMs, authResult.token);
      existing.session.updateAuth(sessionAuth);
      return existing.transport.handleRequest(request);
    },
  };
}
