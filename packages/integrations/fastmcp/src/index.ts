import { FastMCP, UserError, type FastMCPSession } from "fastmcp";
import { WebStreamableHTTPServerTransport } from "fastmcp/edge";
import { z } from "zod";
import {
  createMcpIdentityUseCase,
  createWorkUseCases,
  isEmailVerificationRequiredError,
  type Clock,
  type IdGenerator,
  type McpHttpHandler,
  type McpTokenVerifier,
  type McpVerifiedToken,
  type RealtimeHub,
  type UnitOfWork,
  type WorkUseCaseResult,
} from "@prood/application";
import {
  CONTRACT_VERSION,
  MCP_READ_SCOPE,
  MCP_REQUIRED_WHOAMI_SCOPE,
  MCP_WRITE_SCOPE,
  type ApiErrorCode,
  type McpToolErrorPayload,
} from "@prood/contracts";
import {
  isValidEntityId,
  type AuditActorContext,
  type StatusId,
  type UserId,
  type WorkspaceId,
} from "@prood/domain";

const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 1000;
const DEFAULT_MAX_SESSIONS_PER_PRINCIPAL = 20;

export interface ProodMcpServerDeps {
  resource: string;
  tokenVerifier: McpTokenVerifier;
  uow: UnitOfWork;
  idGenerator: IdGenerator;
  clock: Clock;
  realtimeHub?: RealtimeHub;
  onWhoamiExecuted?: () => void;
  onAuthFailure?: (info: {
    path: string;
    reasonCode: string;
    detail?: string;
  }) => Promise<void> | void;
  sessionIdleTtlMs?: number;
  maxActiveSessions?: number;
  maxSessionsPerPrincipal?: number;
  trustedOrigins?: string[];
}

type ProodMcpSessionAuth = McpVerifiedToken & Record<string, unknown>;

interface ActiveSessionEntry {
  ownerSubject: string;
  ownerClientId: string;
  transport: WebStreamableHTTPServerTransport;
  session: FastMCPSession<ProodMcpSessionAuth>;
  lastActivityAtMs: number;
  tokenExpiresAtMs: number;
  closed: boolean;
  queue: Promise<void>;
}

const TOOL_REQUIRED_SCOPES = new Map<string, readonly string[]>([
  ["whoami", [MCP_REQUIRED_WHOAMI_SCOPE]],
  ["list_projects", [MCP_READ_SCOPE]],
  ["get_project", [MCP_READ_SCOPE]],
  ["list_tasks", [MCP_READ_SCOPE]],
  ["get_task", [MCP_READ_SCOPE]],
  ["search_tasks", [MCP_READ_SCOPE]],
  ["create_task", [MCP_WRITE_SCOPE]],
  ["update_task", [MCP_WRITE_SCOPE]],
  ["start_task", [MCP_WRITE_SCOPE]],
]);

function sanitizeHeaderValue(value: string): string {
  return value
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "'")
    .trim();
}

function buildUnauthorizedResponse(
  status: 401 | 403,
  error: "invalid_token" | "insufficient_scope",
  description: string,
  resourceMetadataUrl: string,
  requiredScope?: string,
): Response {
  const safeDesc = sanitizeHeaderValue(description);
  const parts = [
    `Bearer resource_metadata="${sanitizeHeaderValue(resourceMetadataUrl)}"`,
    `error="${error}"`,
    `error_description="${safeDesc}"`,
  ];
  if (requiredScope) {
    parts.push(`scope="${sanitizeHeaderValue(requiredScope)}"`);
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

function jsonRpcErrorResponse(
  status: number,
  code: number,
  message: string,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

/**
 * Creates a FastMCP server exposing Prood tools over Web-Standard Streamable HTTP,
 * verifying Origin headers, OAuth bearer tokens, per-tool scopes, principal isolation,
 * and bounded session retention.
 */
export function createProodMcpServer(deps: ProodMcpServerDeps): McpHttpHandler {
  const identityUseCase = createMcpIdentityUseCase({
    uow: deps.uow,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  });
  const workUseCases = createWorkUseCases({
    uow: deps.uow,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    realtimeHub: deps.realtimeHub,
  });

  function throwMcpToolError(
    status: number,
    code: ApiErrorCode,
    messageKey: string,
  ): never {
    const payload: McpToolErrorPayload = {
      contractVersion: CONTRACT_VERSION,
      error: { code, status, messageKey },
    };
    throw new UserError(JSON.stringify(payload));
  }

  async function resolveMcpToolActor(
    sessionAuth: ProodMcpSessionAuth | undefined,
    requiredScope: string,
  ): Promise<AuditActorContext> {
    if (
      !sessionAuth ||
      !Array.isArray(sessionAuth.scopes) ||
      !sessionAuth.scopes.includes(requiredScope)
    ) {
      throw new Error(`Insufficient scope: ${requiredScope} is required`);
    }
    try {
      return await identityUseCase.resolveActor(sessionAuth);
    } catch (error) {
      if (isEmailVerificationRequiredError(error)) {
        throwMcpToolError(403, "FORBIDDEN", "error.emailVerificationRequired");
      }
      throw error;
    }
  }

  function unwrapWorkResult<T>(result: WorkUseCaseResult<T>): string {
    if (!result.ok) {
      throwMcpToolError(result.status, result.code, result.messageKey);
    }
    return JSON.stringify(result.data);
  }

  const sessionIdleTtlMs = Math.max(
    1,
    Math.trunc(deps.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS),
  );
  const maxActiveSessions = Math.max(
    1,
    Math.trunc(deps.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS),
  );
  const maxSessionsPerPrincipal = Math.min(
    maxActiveSessions,
    Math.max(
      1,
      Math.trunc(deps.maxSessionsPerPrincipal ?? DEFAULT_MAX_SESSIONS_PER_PRINCIPAL),
    ),
  );

  const trustedOriginSet = deps.trustedOrigins
    ? new Set(
        deps.trustedOrigins
          .map((origin) => {
            try {
              return new URL(origin).origin;
            } catch {
              return origin.replace(/\/+$/, "");
            }
          })
          .filter(Boolean),
      )
    : null;

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

  server.addTool({
    name: "list_projects",
    description:
      "List projects accessible to the authenticated user, optionally filtered by workspace ID.",
    parameters: z.object({
      workspaceId: z.string().optional(),
    }),
    scopes: [MCP_READ_SCOPE],
    annotations: {
      readOnlyHint: true,
      title: "List projects",
    },
    execute: async (args, context) => {
      const actor = await resolveMcpToolActor(context.session, MCP_READ_SCOPE);
      const result = await workUseCases.listAccessibleProjects(actor, {
        ...(args.workspaceId !== undefined
          ? { workspaceId: args.workspaceId as WorkspaceId }
          : {}),
      });
      return unwrapWorkResult(result);
    },
  });

  server.addTool({
    name: "get_project",
    description:
      "Get a project by project ID (prj_...) or issue key prefix (e.g. PRD, APP), optionally scoped by workspace ID.",
    parameters: z.object({
      projectRef: z.string().min(1),
      workspaceId: z.string().optional(),
    }),
    scopes: [MCP_READ_SCOPE],
    annotations: {
      readOnlyHint: true,
      title: "Get project",
    },
    execute: async (args, context) => {
      const actor = await resolveMcpToolActor(context.session, MCP_READ_SCOPE);
      const result = await workUseCases.getProjectByRef(
        actor,
        args.projectRef,
        {
          ...(args.workspaceId !== undefined
            ? { workspaceId: args.workspaceId as WorkspaceId }
            : {}),
        },
      );
      return unwrapWorkResult(result);
    },
  });

  server.addTool({
    name: "list_tasks",
    description:
      "List tasks in a project (including inherited subtasks) by project ID or issue key prefix.",
    parameters: z.object({
      projectRef: z.string().min(1),
      workspaceId: z.string().optional(),
    }),
    scopes: [MCP_READ_SCOPE],
    annotations: {
      readOnlyHint: true,
      title: "List tasks",
    },
    execute: async (args, context) => {
      const actor = await resolveMcpToolActor(context.session, MCP_READ_SCOPE);
      const result = await workUseCases.listProjectTasksByRef(
        actor,
        args.projectRef,
        {
          ...(args.workspaceId !== undefined
            ? { workspaceId: args.workspaceId as WorkspaceId }
            : {}),
        },
      );
      return unwrapWorkResult(result);
    },
  });

  server.addTool({
    name: "get_task",
    description:
      "Get a task by immutable public ID (tsk_...) or issue key (current or historical, e.g. PRD-1 or APP-1).",
    parameters: z.object({
      taskRef: z.string().min(1),
      workspaceId: z.string().optional(),
    }),
    scopes: [MCP_READ_SCOPE],
    annotations: {
      readOnlyHint: true,
      title: "Get task",
    },
    execute: async (args, context) => {
      const actor = await resolveMcpToolActor(context.session, MCP_READ_SCOPE);
      const result = await workUseCases.getTask(actor, args.taskRef, {
        ...(args.workspaceId !== undefined
          ? { workspaceId: args.workspaceId as WorkspaceId }
          : {}),
      });
      return unwrapWorkResult(result);
    },
  });

  server.addTool({
    name: "search_tasks",
    description:
      "Search readable tasks by public ID, issue key, or title/description keyword across accessible workspaces or a scoped workspace/project.",
    parameters: z.object({
      query: z.string().min(1),
      workspaceId: z.string().optional(),
      projectRef: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    scopes: [MCP_READ_SCOPE],
    annotations: {
      readOnlyHint: true,
      title: "Search tasks",
    },
    execute: async (args, context) => {
      const actor = await resolveMcpToolActor(context.session, MCP_READ_SCOPE);
      const result = await workUseCases.searchTasksByRef(actor, {
        query: args.query,
        ...(args.workspaceId !== undefined
          ? { workspaceId: args.workspaceId as WorkspaceId }
          : {}),
        ...(args.projectRef !== undefined
          ? { projectRef: args.projectRef }
          : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      return unwrapWorkResult(result);
    },
  });

  server.addTool({
    name: "create_task",
    description:
      "Idempotently create a task in a project (by prj_... ID or issue key prefix) using a caller-supplied idempotencyKey.",
    parameters: z.object({
      projectRef: z.string().min(1),
      title: z.string().min(1),
      idempotencyKey: z.string().min(1).max(128),
      workspaceId: z.string().optional(),
      description: z.string().optional(),
      parentTaskRef: z.string().min(1).nullable().optional(),
      inheritParentProject: z.boolean().optional(),
      statusId: z.string().nullable().optional(),
      assigneeId: z.string().nullable().optional(),
      dueOn: z.string().nullable().optional(),
    }),
    scopes: [MCP_WRITE_SCOPE],
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      title: "Create task",
    },
    execute: async (args, context) => {
      const actor = await resolveMcpToolActor(context.session, MCP_WRITE_SCOPE);
      const result = await workUseCases.createTaskByProjectRef(
        actor,
        args.projectRef,
        {
          title: args.title,
          idempotencyKey: args.idempotencyKey,
          description: args.description,
          parentTaskRef: args.parentTaskRef,
          inheritParentProject: args.inheritParentProject,
          statusId: args.statusId as StatusId | null | undefined,
          assigneeId: args.assigneeId as UserId | null | undefined,
          dueOn: args.dueOn,
        },
        {
          ...(args.workspaceId !== undefined
            ? { workspaceId: args.workspaceId as WorkspaceId }
            : {}),
        },
      );
      return unwrapWorkResult(result);
    },
  });

  server.addTool({
    name: "update_task",
    description: "Update a task's status or assignee.",
    parameters: z
      .object({
        taskId: z.string().min(1),
        statusId: z.string().nullable().optional(),
        assigneeId: z.string().nullable().optional(),
      })
      .strict(),
    scopes: [MCP_WRITE_SCOPE],
    annotations: {
      readOnlyHint: false,
      title: "Update task",
    },
    execute: async (args, context) => {
      const actor = await resolveMcpToolActor(context.session, MCP_WRITE_SCOPE);
      if (
        !isValidEntityId("tsk", args.taskId) ||
        (args.statusId === undefined && args.assigneeId === undefined)
      ) {
        throwMcpToolError(400, "VALIDATION_ERROR", "error.validation");
      }
      const result = await workUseCases.updateTask(actor, args.taskId, {
        ...(args.statusId !== undefined
          ? { statusId: args.statusId as StatusId | null }
          : {}),
        ...(args.assigneeId !== undefined
          ? { assigneeId: args.assigneeId as UserId | null }
          : {}),
      });
      return unwrapWorkResult(result);
    },
  });

  server.addTool({
    name: "start_task",
    description:
      "Atomically start a task by public ID (tsk_...) or issue key (current or historical): assigns the actor if unassigned, transitions status without regressing, requires reopen=true for completed tasks, and returns the immutable Git branch name.",
    parameters: z.object({
      taskRef: z.string().min(1),
      workspaceId: z.string().optional(),
      reopen: z.boolean().optional(),
    }),
    scopes: [MCP_WRITE_SCOPE],
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      title: "Start task",
    },
    execute: async (args, context) => {
      const actor = await resolveMcpToolActor(context.session, MCP_WRITE_SCOPE);
      const result = await workUseCases.startTask(
        actor,
        args.taskRef,
        {
          ...(args.reopen !== undefined ? { reopen: args.reopen } : {}),
        },
        {
          ...(args.workspaceId !== undefined
            ? { workspaceId: args.workspaceId as WorkspaceId }
            : {}),
        },
      );
      return unwrapWorkResult(result);
    },
  });

  const activeSessions = new Map<string, ActiveSessionEntry>();

  async function closeSessionEntry(entry: ActiveSessionEntry): Promise<void> {
    if (entry.closed) {
      return;
    }
    entry.closed = true;
    await Promise.allSettled([entry.session.close(), entry.transport.close()]);
  }

  function collectExpiredEvictions(nowMs: number): ActiveSessionEntry[] {
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
    return evicted;
  }

  function collectCapacityEvictions(
    nowMs: number,
    ownerSubject: string,
    ownerClientId: string,
  ): ActiveSessionEntry[] {
    const evicted = collectExpiredEvictions(nowMs);

    const principalEntries: Array<[string, ActiveSessionEntry]> = [];
    for (const [sid, entry] of activeSessions) {
      if (
        entry.ownerSubject === ownerSubject &&
        entry.ownerClientId === ownerClientId
      ) {
        principalEntries.push([sid, entry]);
      }
    }
    const maxAllowedForPrincipal = Math.max(0, maxSessionsPerPrincipal - 1);
    while (principalEntries.length > maxAllowedForPrincipal) {
      const oldest = principalEntries.shift();
      if (!oldest) {
        break;
      }
      activeSessions.delete(oldest[0]);
      evicted.push(oldest[1]);
    }

    const maxAllowedGlobal = Math.max(0, maxActiveSessions - 1);
    while (activeSessions.size > maxAllowedGlobal) {
      const oldest = activeSessions.entries().next().value;
      if (!oldest) {
        break;
      }
      activeSessions.delete(oldest[0]);
      evicted.push(oldest[1]);
    }
    return evicted;
  }

  async function evictExpiredSessions(nowMs: number): Promise<void> {
    const evicted = collectExpiredEvictions(nowMs);
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

  function checkTokenScopes(
    parsedBody: unknown,
    tokenScopes: readonly string[],
  ): Response | null {
    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") {
        continue;
      }
      const record = msg as { method?: unknown; params?: { name?: unknown } };
      if (record.method === "tools/call" && typeof record.params?.name === "string") {
        const required = TOOL_REQUIRED_SCOPES.get(record.params.name);
        if (required && required.length > 0) {
          const missing = required.filter((scope) => !tokenScopes.includes(scope));
          if (missing.length > 0) {
            const requiredScope = missing.join(" ");
            return buildUnauthorizedResponse(
              403,
              "insufficient_scope",
              `Insufficient scope: ${requiredScope} required`,
              resourceMetadataUrl,
              requiredScope,
            );
          }
        }
      }
    }
    return null;
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

  function enqueueSessionWork<T>(
    entry: ActiveSessionEntry,
    work: () => Promise<T>,
  ): Promise<T> {
    const next = entry.queue.then(work, work);
    entry.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    async handleRequest(request: Request): Promise<Response> {
      const requestPath = (() => {
        try {
          return new URL(request.url).pathname;
        } catch {
          return "/mcp";
        }
      })();
      const notifyAuthFailure = async (
        reasonCode: string,
        detail?: string,
      ): Promise<void> => {
        if (!deps.onAuthFailure) {
          return;
        }
        try {
          await deps.onAuthFailure({ path: requestPath, reasonCode, detail });
        } catch {
          // Preserve HTTP auth response if audit recording fails
        }
      };

      const originHeader = request.headers.get("origin");
      if (originHeader && trustedOriginSet && trustedOriginSet.size > 0) {
        let normalizedOrigin = originHeader;
        try {
          normalizedOrigin = new URL(originHeader).origin;
        } catch {
          await notifyAuthFailure("INVALID_ORIGIN", "Malformed Origin header");
          return jsonRpcErrorResponse(403, -32003, "Invalid Origin header");
        }
        if (!trustedOriginSet.has(normalizedOrigin)) {
          await notifyAuthFailure("ORIGIN_NOT_ALLOWED", normalizedOrigin);
          return jsonRpcErrorResponse(403, -32003, "Origin not allowed");
        }
      }

      const nowMs = deps.clock.now().getTime();
      await evictExpiredSessions(nowMs);

      const authResult = await deps.tokenVerifier.verifyBearerToken(
        request.headers,
      );
      if (!authResult.ok) {
        await notifyAuthFailure(
          authResult.error.toUpperCase(),
          authResult.description,
        );
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
          return jsonRpcErrorResponse(400, -32700, "Parse error");
        }

        if (sessionId) {
          const existing = activeSessions.get(sessionId);
          if (!existing || existing.closed) {
            return jsonRpcErrorResponse(404, -32001, "Session not found");
          }
          if (
            existing.ownerSubject !== authResult.token.subject ||
            existing.ownerClientId !== authResult.token.clientId
          ) {
            await notifyAuthFailure(
              "SESSION_PRINCIPAL_MISMATCH",
              "Session belongs to a different principal",
            );
            return jsonRpcErrorResponse(
              403,
              -32003,
              "Session belongs to a different principal",
            );
          }
          const earlyScopeError = checkTokenScopes(
            parsedBody,
            authResult.token.scopes,
          );
          if (earlyScopeError) {
            await notifyAuthFailure("INSUFFICIENT_SCOPE", "Missing tool scope");
            return earlyScopeError;
          }

          return enqueueSessionWork(existing, async () => {
            if (existing.closed || activeSessions.get(sessionId) !== existing) {
              return jsonRpcErrorResponse(404, -32001, "Session not found");
            }
            const reqNowMs = deps.clock.now().getTime();
            touchSession(sessionId, existing, reqNowMs, authResult.token);
            existing.session.updateAuth(sessionAuth);
            const scopeError = checkSessionScopes(existing.session, parsedBody);
            if (scopeError) {
              await notifyAuthFailure("INSUFFICIENT_SCOPE", "Missing tool scope");
              return scopeError;
            }
            return existing.transport.handleRequest(request, parsedBody);
          });
        }

        let connectedSession: FastMCPSession<ProodMcpSessionAuth> | undefined;
        let initializedSessionId: string | undefined;
        const pendingEvictionCloses: Promise<void>[] = [];
        const transport = new WebStreamableHTTPServerTransport({
          sessionIdGenerator: () => globalThis.crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (newSessionId) => {
            initializedSessionId = newSessionId;
            const callbackNowMs = deps.clock.now().getTime();
            const overflow = collectCapacityEvictions(
              callbackNowMs,
              authResult.token.subject,
              authResult.token.clientId,
            );
            for (const entry of overflow) {
              pendingEvictionCloses.push(closeSessionEntry(entry));
            }
            if (connectedSession) {
              activeSessions.set(newSessionId, {
                ownerSubject: authResult.token.subject,
                ownerClientId: authResult.token.clientId,
                transport,
                session: connectedSession,
                lastActivityAtMs: callbackNowMs,
                tokenExpiresAtMs:
                  authResult.token.expiresAt > 0
                    ? authResult.token.expiresAt * 1000
                    : 0,
                closed: false,
                queue: Promise.resolve(),
              });
            }
          },
          onsessionclosed: (closedSessionId) => {
            const entry = activeSessions.get(closedSessionId);
            activeSessions.delete(closedSessionId);
            if (entry) {
              pendingEvictionCloses.push(closeSessionEntry(entry));
            }
          },
        });

        connectedSession = await server.connect(transport, sessionAuth);
        const scopeError = checkSessionScopes(connectedSession, parsedBody);
        if (scopeError) {
          await notifyAuthFailure("INSUFFICIENT_SCOPE", "Missing tool scope");
          await Promise.allSettled([connectedSession.close(), transport.close()]);
          return scopeError;
        }
        try {
          return await transport.handleRequest(request, parsedBody);
        } finally {
          if (pendingEvictionCloses.length > 0) {
            await Promise.allSettled(pendingEvictionCloses);
          }
          if (!initializedSessionId) {
            await Promise.allSettled([connectedSession.close(), transport.close()]);
          }
        }
      }

      if (!sessionId) {
        return jsonRpcErrorResponse(400, -32000, "Missing mcp-session-id header");
      }

      const existing = activeSessions.get(sessionId);
      if (!existing || existing.closed) {
        return jsonRpcErrorResponse(404, -32001, "Session not found");
      }
      if (
        existing.ownerSubject !== authResult.token.subject ||
        existing.ownerClientId !== authResult.token.clientId
      ) {
        await notifyAuthFailure(
          "SESSION_PRINCIPAL_MISMATCH",
          "Session belongs to a different principal",
        );
        return jsonRpcErrorResponse(
          403,
          -32003,
          "Session belongs to a different principal",
        );
      }

      touchSession(sessionId, existing, nowMs, authResult.token);
      existing.session.updateAuth(sessionAuth);
      const response = await existing.transport.handleRequest(request);
      if (request.method === "DELETE") {
        activeSessions.delete(sessionId);
        await closeSessionEntry(existing);
      }
      return response;
    },

    async close(): Promise<void> {
      const entries = Array.from(activeSessions.values());
      activeSessions.clear();
      if (entries.length > 0) {
        await Promise.allSettled(entries.map(closeSessionEntry));
      }
    },
  };
}
