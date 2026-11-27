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

export interface ProodMcpServerDeps {
  resource: string;
  tokenVerifier: McpTokenVerifier;
  uow: UnitOfWork;
  idGenerator: IdGenerator;
  clock: Clock;
  onWhoamiExecuted?: () => void;
}

type ProodMcpSessionAuth = McpVerifiedToken & Record<string, unknown>;

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
 * verifying OAuth bearer tokens and per-tool scopes on every request.
 */
export function createProodMcpServer(deps: ProodMcpServerDeps): McpHttpHandler {
  const identityUseCase = createMcpIdentityUseCase({
    uow: deps.uow,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  });

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

  const activeSessions = new Map<
    string,
    {
      transport: WebStreamableHTTPServerTransport;
      session: FastMCPSession<ProodMcpSessionAuth>;
    }
  >();

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
          existing.session.updateAuth(sessionAuth);
          const scopeError = checkSessionScopes(existing.session, parsedBody);
          if (scopeError) {
            return scopeError;
          }
          return existing.transport.handleRequest(request, parsedBody);
        }

        let connectedSession: FastMCPSession<ProodMcpSessionAuth> | undefined;
        const transport = new WebStreamableHTTPServerTransport({
          sessionIdGenerator: () => globalThis.crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (newSessionId) => {
            if (connectedSession) {
              activeSessions.set(newSessionId, {
                transport,
                session: connectedSession,
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

      existing.session.updateAuth(sessionAuth);
      return existing.transport.handleRequest(request);
    },
  };
}
