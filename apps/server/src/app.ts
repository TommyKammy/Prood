import { Hono, type Context } from "hono";
import {
  createHealthCheckUseCase,
  createIdentityUseCases,
  createRealtimeUseCases,
  createWorkUseCases,
  isEmailVerificationRequiredError,
  type AuthPort,
  type AuthSessionInfo,
  type Clock,
  type DatabaseHealthPort,
  type IdGenerator,
  type McpHttpHandler,
  type McpTokenVerifier,
  type RealtimeHub,
  type UnitOfWork,
  type WorkUseCaseResult,
} from "@prood/application";
import {
  CONTRACT_VERSION,
  type ApiErrorResponse,
  type CopyTaskRequest,
  type CreateProjectRequest,
  type CreateTaskRequest,
  type DeleteProjectStatusRequest,
  type EnableDevProjectRequest,
  type MoveTaskRequest,
  type StartTaskRequest,
  type UpdateDevProjectSettingsRequest,
  type UpdateProjectStatusRequest,
  type UpdateTaskRequest,
  type UpdateWorkspaceSettingsRequest,
} from "@prood/contracts";
import {
  isValidEntityId,
  type AuditActorContext,
  type LocaleCode,
  type ProjectId,
  type StatusId,
  type WorkspaceId,
} from "@prood/domain";

export interface RealtimeAppOptions {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  retryMs?: number;
  retentionMs?: number;
  maxEvents?: number;
  maxBufferedBytes?: number;
  maxBackpressureMs?: number;
  shutdownSignal?: AbortSignal;
}

export interface AppDeps {
  operatorConsole?: string;
  clock: Clock;
  dbHealth: DatabaseHealthPort;
  locale?: LocaleCode;
  auth?: AuthPort;
  uow?: UnitOfWork;
  idGenerator?: IdGenerator;
  mcpAuth?: McpTokenVerifier;
  mcpHandler?: McpHttpHandler;
  realtimeHub?: RealtimeHub;
  realtime?: RealtimeAppOptions;
}

function errorBody(
  code: ApiErrorResponse["error"]["code"],
  messageKey: string,
): ApiErrorResponse {
  return {
    contractVersion: CONTRACT_VERSION,
    error: { code, messageKey },
  };
}

/**
 * Web-Standard Hono application with zero Node-specific, Better-Auth, FastMCP,
 * or DB-driver imports so the HTTP layer can also run on Cloudflare Workers.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const getHealth = createHealthCheckUseCase(deps);

  app.onError((_err, c) => {
    return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
  });

  app.get("/healthz", async (c) => {
    const health = await getHealth();
    return c.json({ status: health.status, dbDriver: health.dbDriver });
  });

  app.get("/api/v1/health", async (c) => {
    const health = await getHealth();
    return c.json(health);
  });

  if (deps.mcpAuth) {
    const mcpAuth = deps.mcpAuth;
    app.get("/.well-known/oauth-protected-resource", (c) =>
      c.json(mcpAuth.getProtectedResourceMetadata()),
    );
    app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
      c.json(mcpAuth.getProtectedResourceMetadata()),
    );
    app.get("/.well-known/oauth-authorization-server", async (c) =>
      c.json(await mcpAuth.getAuthorizationServerMetadata()),
    );
    app.get("/.well-known/oauth-authorization-server/api/auth", async (c) =>
      c.json(await mcpAuth.getAuthorizationServerMetadata()),
    );
  }

  if (deps.mcpHandler) {
    const mcpHandler = deps.mcpHandler;
    app.all("/mcp", (c) => mcpHandler.handleRequest(c.req.raw));
    app.all("/mcp/*", (c) => mcpHandler.handleRequest(c.req.raw));
  }

  if (deps.auth) {
    const auth = deps.auth;
    const hasCoreDeps = Boolean(deps.uow && deps.idGenerator);
    const identityUseCases = hasCoreDeps
      ? createIdentityUseCases({
          uow: deps.uow!,
          idGenerator: deps.idGenerator!,
          clock: deps.clock,
        })
      : null;
    const workUseCases = hasCoreDeps
      ? createWorkUseCases({
          uow: deps.uow!,
          idGenerator: deps.idGenerator!,
          clock: deps.clock,
          realtimeHub: deps.realtimeHub,
        })
      : null;
    const realtimeUseCases = hasCoreDeps
      ? createRealtimeUseCases({
          uow: deps.uow!,
          idGenerator: deps.idGenerator!,
          clock: deps.clock,
          retentionMs: deps.realtime?.retentionMs,
          maxEvents: deps.realtime?.maxEvents,
        })
      : null;

    async function recordAuthFailure(
      path: string,
      reasonCode: string,
      detail?: string,
    ): Promise<void> {
      if (!workUseCases) {
        return;
      }
      try {
        await workUseCases.recordEntryAuthFailure({
          channel: "web",
          path,
          reasonCode,
          detail,
        });
      } catch {
        // Keep HTTP error response deterministic even if outbox logging fails
      }
    }

    app.all("/api/auth/*", async (c) => {
      const res = await auth.handler(c.req.raw);
      if (
        c.req.path.startsWith("/api/auth/sign-in/") &&
        res.status >= 400 &&
        res.status < 500
      ) {
        await recordAuthFailure(c.req.path, "AUTH_SIGN_IN_FAILED", `HTTP_${res.status}`);
      }
      return res;
    });

    async function requireSessionOrRecord(
      c: Context,
    ): Promise<AuthSessionInfo | null> {
      const session = await auth.getSession(c.req.raw.headers);
      if (!session) {
        await recordAuthFailure(c.req.path, "UNAUTHORIZED");
        return null;
      }
      return session;
    }

    async function resolveActorOrRespond(
      c: Context,
      session: AuthSessionInfo,
    ): Promise<
      { ok: true; actor: AuditActorContext } | { ok: false; response: Response }
    > {
      try {
        const user = await identityUseCases!.resolveProodUser(session);
        return {
          ok: true,
          actor: {
            userId: user.id,
            actorType: "user",
            channel: "web",
          },
        };
      } catch (error) {
        if (isEmailVerificationRequiredError(error)) {
          await recordAuthFailure(c.req.path, "EMAIL_VERIFICATION_REQUIRED");
          return {
            ok: false,
            response: c.json(
              errorBody("FORBIDDEN", "error.emailVerificationRequired"),
              403,
            ),
          };
        }
        throw error;
      }
    }

    async function parseJsonBody<T extends Record<string, unknown>>(
      c: Context,
    ): Promise<T | null> {
      try {
        const parsed = (await c.req.json()) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return null;
        }
        return parsed as T;
      } catch {
        return null;
      }
    }

    async function parseOptionalJsonBody<T extends Record<string, unknown>>(
      c: Context,
    ): Promise<T | null> {
      const raw = await c.req.text();
      if (!raw.trim()) {
        return {} as T;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return null;
        }
        return parsed as T;
      } catch {
        return null;
      }
    }

    function sendWorkResult<T>(c: Context, result: WorkUseCaseResult<T>): Response {
      if (!result.ok) {
        return c.json(errorBody(result.code, result.messageKey), result.status);
      }
      return c.json(result.data, 200);
    }

    app.get("/api/v1/me", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      try {
        const profile = await identityUseCases.getCurrentUserProfile(session);
        return c.json(profile, 200);
      } catch (error) {
        if (isEmailVerificationRequiredError(error)) {
          await recordAuthFailure(c.req.path, "EMAIL_VERIFICATION_REQUIRED");
          return c.json(
            errorBody("FORBIDDEN", "error.emailVerificationRequired"),
            403,
          );
        }
        throw error;
      }
    });

    app.get("/api/v1/workspaces/:workspaceId/membership", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }

      const workspaceId = c.req.param("workspaceId");
      if (!isValidEntityId("wks", workspaceId)) {
        return c.json(errorBody("FORBIDDEN", "error.forbidden"), 403);
      }

      try {
        const result = await identityUseCases.getWorkspaceMembershipForUser(
          session,
          workspaceId,
        );
        if (!result) {
          return c.json(errorBody("FORBIDDEN", "error.forbidden"), 403);
        }
        return c.json(result, 200);
      } catch (error) {
        if (isEmailVerificationRequiredError(error)) {
          await recordAuthFailure(c.req.path, "EMAIL_VERIFICATION_REQUIRED");
          return c.json(
            errorBody("FORBIDDEN", "error.emailVerificationRequired"),
            403,
          );
        }
        throw error;
      }
    });

    app.post("/api/v1/projects/:projectId/automation/:rule", async (c) => {
      c.header("Cache-Control", "no-store");
      if (c.req.header("content-type")?.split(";")[0] !== "application/json")
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      const session = await requireSessionOrRecord(c);
      if (!session) return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      if (!workUseCases || !identityUseCases)
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      const actor = await resolveActorOrRespond(c, session);
      if (!actor.ok) return actor.response;
      const project = c.req.param("projectId"),
        rule = c.req.param("rule");
      const body = await parseJsonBody<Record<string, unknown>>(c);
      if (!isValidEntityId("prj", project) || !body)
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      if (
        body.op === "options" ||
        body.op === "history" ||
        body.op === "simulate" ||
        body.op === "keep" ||
        body.op === "undo"
      ) {
        if (
          body.task !== undefined &&
          (typeof body.task !== "string" || !isValidEntityId("tsk", body.task))
        )
          return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
        const task =
          typeof body.task === "string" && isValidEntityId("tsk", body.task)
            ? body.task
            : undefined;
        const response =
          body.op === "options"
            ? await workUseCases.automationOptions(actor.actor, project)
            : body.op === "history"
              ? await workUseCases.automationHistory(
                  actor.actor,
                  project,
                  task,
                  task ? undefined : rule,
                )
              : body.op === "simulate" && task
                ? await workUseCases.simulateAutomation(
                    actor.actor,
                    project,
                    rule,
                    task,
                    body.definition,
                  )
                : (body.op === "undo" || body.op === "keep") && typeof body.run === "string"
                  ? await workUseCases.decideAutomation(
                      actor.actor,
                      project,
                      rule,
                      body.run,
                      body.op,
                    )
                  : null;
        if (!response) return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
        if (!response.ok)
          return c.json(errorBody(response.code, response.messageKey), response.status);
        if (
          body.op === "options" &&
          deps.operatorConsole &&
          response.data &&
          typeof response.data === "object" &&
          "manage" in response.data &&
          response.data.manage
        )
          return c.json({ ...response.data, operatorConsole: deps.operatorConsole });
        return c.json(response.data);
      }
      const result =
        body.op === "start" &&
        typeof body.task === "string" &&
        isValidEntityId("tsk", body.task)
          ? await workUseCases.manualAutomation(actor.actor, project, rule, body.task)
          : await workUseCases.manageAutomation(actor.actor, project, rule, body);
      if (!result.ok) return c.json(errorBody(result.code, result.messageKey), result.status);
      return c.json(result.data);
    });

    app.post("/api/v1/workspaces/:workspaceId/projects", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const workspaceId = c.req.param("workspaceId");
      if (!isValidEntityId("wks", workspaceId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const body = await parseJsonBody<CreateProjectRequest & Record<string, unknown>>(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.createProject(
        actorResult.actor,
        workspaceId,
        body,
      );
      if (!result.ok) {
        return c.json(errorBody(result.code, result.messageKey), result.status);
      }
      return c.json(result.data, 201);
    });

    app.get("/api/v1/workspaces/:workspaceId/projects", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const workspaceId = c.req.param("workspaceId");
      if (!isValidEntityId("wks", workspaceId)) {
        return c.json(errorBody("FORBIDDEN", "error.forbidden"), 403);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.listProjects(actorResult.actor, workspaceId);
      return sendWorkResult(c, result);
    });

    app.post("/api/v1/projects/:projectId/tasks", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const projectId = c.req.param("projectId");
      if (!isValidEntityId("prj", projectId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const body = await parseJsonBody<CreateTaskRequest & Record<string, unknown>>(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const headerIdempotencyKey = c.req.header("idempotency-key");
      if (headerIdempotencyKey !== undefined) {
        if (
          body.idempotencyKey !== undefined &&
          (typeof body.idempotencyKey !== "string" ||
            body.idempotencyKey.trim() !== headerIdempotencyKey.trim())
        ) {
          return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
        }
        body.idempotencyKey = headerIdempotencyKey;
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.createTask(actorResult.actor, projectId, body);
      if (!result.ok) {
        return c.json(errorBody(result.code, result.messageKey), result.status);
      }
      return c.json(result.data, result.data.idempotentReplay ? 200 : 201);
    });

    app.get("/api/v1/projects/:projectId/tasks", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const projectId = c.req.param("projectId");
      if (!isValidEntityId("prj", projectId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.listProjectTasks(actorResult.actor, projectId);
      return sendWorkResult(c, result);
    });

    function parseWorkspaceQueryParam(
      c: Context,
    ): { ok: true; workspaceId?: WorkspaceId } | { ok: false; response: Response } {
      const raw = c.req.query("workspaceId");
      if (raw === undefined || raw === "") {
        return { ok: true };
      }
      if (!isValidEntityId("wks", raw)) {
        return {
          ok: false,
          response: c.json(errorBody("NOT_FOUND", "error.notFound"), 404),
        };
      }
      return { ok: true, workspaceId: raw };
    }

    async function handleTaskRead(
      c: Context,
      explicitWorkspaceId?: WorkspaceId,
    ): Promise<Response> {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      let workspaceId = explicitWorkspaceId;
      if (workspaceId === undefined) {
        const parsedWs = parseWorkspaceQueryParam(c);
        if (!parsedWs.ok) {
          return parsedWs.response;
        }
        workspaceId = parsedWs.workspaceId;
      } else if (!isValidEntityId("wks", workspaceId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const taskRef = c.req.param("taskRef") ?? "";
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.getTask(actorResult.actor, taskRef, {
        ...(workspaceId ? { workspaceId } : {}),
      });
      return sendWorkResult(c, result);
    }

    async function handleTaskUpdate(
      c: Context,
      explicitWorkspaceId?: WorkspaceId,
    ): Promise<Response> {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      let workspaceId = explicitWorkspaceId;
      if (workspaceId === undefined) {
        const parsedWs = parseWorkspaceQueryParam(c);
        if (!parsedWs.ok) {
          return parsedWs.response;
        }
        workspaceId = parsedWs.workspaceId;
      } else if (!isValidEntityId("wks", workspaceId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const taskRef = c.req.param("taskRef") ?? "";
      const body = await parseJsonBody<UpdateTaskRequest & Record<string, unknown>>(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.updateTask(actorResult.actor, taskRef, body, {
        ...(workspaceId ? { workspaceId } : {}),
      });
      return sendWorkResult(c, result);
    }

    async function handleTaskMove(
      c: Context,
      explicitWorkspaceId?: WorkspaceId,
    ): Promise<Response> {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      let workspaceId = explicitWorkspaceId;
      if (workspaceId === undefined) {
        const parsedWs = parseWorkspaceQueryParam(c);
        if (!parsedWs.ok) {
          return parsedWs.response;
        }
        workspaceId = parsedWs.workspaceId;
      } else if (!isValidEntityId("wks", workspaceId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const taskRef = c.req.param("taskRef") ?? "";
      const body = await parseJsonBody<MoveTaskRequest & Record<string, unknown>>(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.moveTask(actorResult.actor, taskRef, body, {
        ...(workspaceId ? { workspaceId } : {}),
      });
      return sendWorkResult(c, result);
    }

    app.get("/api/v1/tasks/:taskRef", (c) => handleTaskRead(c));
    app.patch("/api/v1/tasks/:taskRef", (c) => handleTaskUpdate(c));
    app.post("/api/v1/tasks/:taskRef/move", (c) => handleTaskMove(c));

    async function handleTaskStart(
      c: Context,
      explicitWorkspaceId?: WorkspaceId,
    ): Promise<Response> {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      let workspaceId = explicitWorkspaceId;
      if (workspaceId === undefined) {
        const parsedWs = parseWorkspaceQueryParam(c);
        if (!parsedWs.ok) {
          return parsedWs.response;
        }
        workspaceId = parsedWs.workspaceId;
      } else if (!isValidEntityId("wks", workspaceId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const taskRef = c.req.param("taskRef") ?? "";
      const body = await parseOptionalJsonBody<StartTaskRequest & Record<string, unknown>>(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.startTask(actorResult.actor, taskRef, body, {
        ...(workspaceId ? { workspaceId } : {}),
      });
      return sendWorkResult(c, result);
    }

    app.post("/api/v1/tasks/:taskRef/start", (c) => handleTaskStart(c));

    app.get("/api/v1/workspaces/:workspaceId/projects/:projectRef", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const workspaceId = c.req.param("workspaceId");
      if (!isValidEntityId("wks", workspaceId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const projectRef = c.req.param("projectRef");
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.getProject(
        actorResult.actor,
        workspaceId,
        projectRef,
      );
      return sendWorkResult(c, result);
    });

    app.get("/api/v1/workspaces/:workspaceId/tasks/search", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const workspaceId = c.req.param("workspaceId");
      if (!isValidEntityId("wks", workspaceId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const query = c.req.query("q") ?? "";
      const projectRef = c.req.query("projectId") ?? c.req.query("project");
      const limitParam = c.req.query("limit");
      const parsedLimit =
        limitParam !== undefined && limitParam !== ""
          ? Number(limitParam)
          : undefined;
      if (parsedLimit !== undefined && !Number.isFinite(parsedLimit)) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const result = await workUseCases.searchTasks(actorResult.actor, workspaceId, {
        query,
        ...(projectRef ? { projectRef } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      });
      return sendWorkResult(c, result);
    });

    app.get("/api/v1/workspaces/:workspaceId/tasks/:taskRef", (c) =>
      handleTaskRead(c, c.req.param("workspaceId") as WorkspaceId),
    );
    app.patch("/api/v1/workspaces/:workspaceId/tasks/:taskRef", (c) =>
      handleTaskUpdate(c, c.req.param("workspaceId") as WorkspaceId),
    );
    app.post("/api/v1/workspaces/:workspaceId/tasks/:taskRef/move", (c) =>
      handleTaskMove(c, c.req.param("workspaceId") as WorkspaceId),
    );
    app.post("/api/v1/workspaces/:workspaceId/tasks/:taskRef/start", (c) =>
      handleTaskStart(c, c.req.param("workspaceId") as WorkspaceId),
    );

    app.get("/api/v1/workspaces/:workspaceId/settings", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const workspaceId = c.req.param("workspaceId");
      if (!isValidEntityId("wks", workspaceId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.getWorkspaceSettings(
        actorResult.actor,
        workspaceId,
      );
      return sendWorkResult(c, result);
    });

    app.patch("/api/v1/workspaces/:workspaceId/settings", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const workspaceId = c.req.param("workspaceId");
      if (!isValidEntityId("wks", workspaceId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const body = await parseJsonBody<
        UpdateWorkspaceSettingsRequest & Record<string, unknown>
      >(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.updateWorkspaceSettings(
        actorResult.actor,
        workspaceId,
        body,
      );
      return sendWorkResult(c, result);
    });

    app.get("/api/v1/projects/:projectId/dev-settings", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const projectId = c.req.param("projectId");
      if (!isValidEntityId("prj", projectId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.getProjectDevSettings(
        actorResult.actor,
        projectId,
      );
      return sendWorkResult(c, result);
    });

    app.post("/api/v1/projects/:projectId/dev-settings/enable", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const projectId = c.req.param("projectId");
      if (!isValidEntityId("prj", projectId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const body = await parseJsonBody<
        EnableDevProjectRequest & Record<string, unknown>
      >(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.enableDevProject(
        actorResult.actor,
        projectId,
        body,
      );
      return sendWorkResult(c, result);
    });

    app.patch("/api/v1/projects/:projectId/dev-settings", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const projectId = c.req.param("projectId");
      if (!isValidEntityId("prj", projectId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const body = await parseJsonBody<
        UpdateDevProjectSettingsRequest & Record<string, unknown>
      >(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.updateDevProjectSettings(
        actorResult.actor,
        projectId,
        body,
      );
      return sendWorkResult(c, result);
    });

    app.patch("/api/v1/projects/:projectId/statuses/:statusId", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const projectId = c.req.param("projectId");
      const statusId = c.req.param("statusId");
      if (!isValidEntityId("prj", projectId) || !isValidEntityId("sts", statusId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const body = await parseJsonBody<
        UpdateProjectStatusRequest & Record<string, unknown>
      >(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.updateProjectStatus(
        actorResult.actor,
        projectId,
        statusId as StatusId,
        body,
      );
      return sendWorkResult(c, result);
    });

    app.delete("/api/v1/projects/:projectId/statuses/:statusId", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const projectId = c.req.param("projectId");
      const statusId = c.req.param("statusId");
      if (!isValidEntityId("prj", projectId) || !isValidEntityId("sts", statusId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const body = await parseOptionalJsonBody<
        DeleteProjectStatusRequest & Record<string, unknown>
      >(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.deleteProjectStatus(
        actorResult.actor,
        projectId,
        statusId as StatusId,
        body,
      );
      return sendWorkResult(c, result);
    });

    app.post("/api/v1/tasks/:taskRef/copy", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const parsedWs = parseWorkspaceQueryParam(c);
      if (!parsedWs.ok) {
        return parsedWs.response;
      }
      const taskRef = c.req.param("taskRef");
      const body = await parseJsonBody<CopyTaskRequest & Record<string, unknown>>(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.copyTask(actorResult.actor, taskRef, body, {
        ...(parsedWs.workspaceId ? { workspaceId: parsedWs.workspaceId } : {}),
      });
      if (!result.ok) {
        return c.json(errorBody(result.code, result.messageKey), result.status);
      }
      return c.json(result.data, 201);
    });

    app.delete("/api/v1/tasks/:taskRef", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const parsedWs = parseWorkspaceQueryParam(c);
      if (!parsedWs.ok) {
        return parsedWs.response;
      }
      const taskRef = c.req.param("taskRef");
      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }
      const result = await workUseCases.deleteTask(actorResult.actor, taskRef, {
        ...(parsedWs.workspaceId ? { workspaceId: parsedWs.workspaceId } : {}),
      });
      return sendWorkResult(c, result);
    });

    app.get("/api/v1/workspaces/:workspaceId/events", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !realtimeUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }

      const workspaceId = c.req.param("workspaceId");
      if (!isValidEntityId("wks", workspaceId)) {
        return c.json(errorBody("FORBIDDEN", "error.forbidden"), 403);
      }

      const rawProjectId = c.req.query("projectId");
      let projectId: ProjectId | null = null;
      if (rawProjectId !== undefined && rawProjectId !== "") {
        if (!isValidEntityId("prj", rawProjectId)) {
          return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
        }
        projectId = rawProjectId;
      }

      const actorResult = await resolveActorOrRespond(c, session);
      if (!actorResult.ok) {
        return actorResult.response;
      }

      const requestedCursor =
        c.req.header("last-event-id") ?? c.req.query("cursor") ?? null;
      const open = await realtimeUseCases.openSubscription(
        actorResult.actor,
        workspaceId,
        {
          projectId,
          cursor: requestedCursor,
        },
      );
      if (!open.ok) {
        return c.json(errorBody(open.code, open.messageKey), open.status);
      }

      const authHeaders = new Headers(c.req.raw.headers);
      const pollIntervalMs = Math.max(
        25,
        Math.trunc(deps.realtime?.pollIntervalMs ?? 250),
      );
      const heartbeatIntervalMs = Math.max(
        500,
        Math.trunc(deps.realtime?.heartbeatIntervalMs ?? 15_000),
      );
      const retryMs = Math.max(250, Math.trunc(deps.realtime?.retryMs ?? 1_500));
      const maxBufferedBytes = Math.max(
        64,
        Math.trunc(deps.realtime?.maxBufferedBytes ?? 65_536),
      );
      const maxBackpressureMs = Math.max(
        50,
        Math.trunc(deps.realtime?.maxBackpressureMs ?? 30_000),
      );

      const abortSignals = [c.req.raw.signal];
      if (deps.realtime?.shutdownSignal) {
        abortSignals.push(deps.realtime.shutdownSignal);
      }
      const streamSignal =
        abortSignals.length === 1
          ? abortSignals[0]!
          : AbortSignal.any(abortSignals);

      const encoder = new TextEncoder();
      let currentCursor = open.parsedCursor;
      let closed = false;
      let pumping = false;
      let dirty = false;
      let pausedForBackpressure = false;
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let backpressureTimer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribeHub: (() => void) | undefined;
      let onAbort: (() => void) | undefined;
      let schedulePollFn: (() => void) | undefined;
      let drainPendingFn: (() => Promise<void>) | undefined;
      let cleanupFn: (() => void) | undefined;

      const isBackpressured = (): boolean =>
        streamController !== null &&
        streamController.desiredSize !== null &&
        streamController.desiredSize <= 0;

      const clearBackpressureTimeout = () => {
        if (backpressureTimer !== undefined) {
          clearTimeout(backpressureTimer);
          backpressureTimer = undefined;
        }
      };

      const armBackpressureTimeout = () => {
        if (closed || streamSignal.aborted || backpressureTimer !== undefined) {
          return;
        }
        backpressureTimer = setTimeout(() => {
          backpressureTimer = undefined;
          if (!closed && isBackpressured()) {
            cleanupFn?.();
          }
        }, maxBackpressureMs);
      };

      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            streamController = controller;
            const cleanup = () => {
              if (closed) {
                return;
              }
              closed = true;
              if (pollTimer !== undefined) {
                clearTimeout(pollTimer);
                pollTimer = undefined;
              }
              if (heartbeatTimer !== undefined) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = undefined;
              }
              clearBackpressureTimeout();
              unsubscribeHub?.();
              unsubscribeHub = undefined;
              if (onAbort) {
                streamSignal.removeEventListener("abort", onAbort);
                onAbort = undefined;
              }
              try {
                controller.close();
              } catch {
                // Stream controller may already be closed
              }
            };
            cleanupFn = cleanup;

            const enqueueFrame = (frame: string): boolean => {
              if (closed || streamSignal.aborted) {
                cleanup();
                return false;
              }
              try {
                controller.enqueue(encoder.encode(frame));
                if (isBackpressured()) {
                  pausedForBackpressure = true;
                  armBackpressureTimeout();
                }
                return true;
              } catch {
                cleanup();
                return false;
              }
            };

            const enqueueSseEvent = (
              eventName: string,
              data: unknown,
              id?: string,
            ): boolean => {
              const lines: string[] = [];
              if (id !== undefined) {
                lines.push(`id: ${id}`);
              }
              lines.push(`event: ${eventName}`);
              lines.push(`data: ${JSON.stringify(data)}`);
              return enqueueFrame(`${lines.join("\n")}\n\n`);
            };

            const emitRevokedAndClose = () => {
              enqueueSseEvent("revoked", {
                contractVersion: CONTRACT_VERSION,
                type: "revoked",
                workspaceId,
                projectId,
              });
              cleanup();
            };

            const schedulePollTimer = () => {
              if (
                closed ||
                streamSignal.aborted ||
                pausedForBackpressure ||
                isBackpressured()
              ) {
                return;
              }
              if (pollTimer !== undefined) {
                clearTimeout(pollTimer);
              }
              pollTimer = setTimeout(() => {
                pollTimer = undefined;
                void drainPending();
              }, pollIntervalMs);
            };
            schedulePollFn = schedulePollTimer;

            const drainPending = async () => {
              if (closed || streamSignal.aborted) {
                cleanup();
                return;
              }
              if (isBackpressured()) {
                pausedForBackpressure = true;
                dirty = true;
                armBackpressureTimeout();
                return;
              }
              if (pumping) {
                dirty = true;
                return;
              }
              pumping = true;
              try {
                do {
                  dirty = false;
                  if (closed || streamSignal.aborted) {
                    cleanup();
                    return;
                  }
                  if (isBackpressured()) {
                    pausedForBackpressure = true;
                    dirty = true;
                    armBackpressureTimeout();
                    return;
                  }
                  const liveSession = await auth.getSession(authHeaders);
                  if (!liveSession) {
                    emitRevokedAndClose();
                    return;
                  }
                  const polled = await realtimeUseCases.pollSubscription(
                    actorResult.actor,
                    workspaceId,
                    currentCursor,
                    { projectId },
                  );
                  if (closed || streamSignal.aborted) {
                    cleanup();
                    return;
                  }
                  if (polled.status === "revoked") {
                    emitRevokedAndClose();
                    return;
                  }
                  if (polled.status === "resync") {
                    currentCursor = polled.parsedCursor;
                    if (
                      !enqueueSseEvent(
                        "resync",
                        {
                          contractVersion: CONTRACT_VERSION,
                          type: "resync",
                          workspaceId,
                          projectId,
                          reason: polled.reason,
                          cursor: polled.cursor,
                        },
                        polled.cursor,
                      )
                    ) {
                      return;
                    }
                    if (isBackpressured()) {
                      pausedForBackpressure = true;
                      armBackpressureTimeout();
                      return;
                    }
                    continue;
                  }

                  let pausedMidBatch = false;
                  for (let i = 0; i < polled.items.length; i++) {
                    if (i > 0 && isBackpressured()) {
                      currentCursor = polled.itemCursors[i - 1]!;
                      pausedForBackpressure = true;
                      dirty = true;
                      armBackpressureTimeout();
                      pausedMidBatch = true;
                      break;
                    }
                    const item = polled.items[i]!;
                    if (!enqueueSseEvent("change", item, item.cursor)) {
                      return;
                    }
                  }
                  if (pausedMidBatch) {
                    return;
                  }
                  currentCursor = polled.nextCursor;
                  if (polled.hasMore) {
                    dirty = true;
                    if (isBackpressured()) {
                      pausedForBackpressure = true;
                      armBackpressureTimeout();
                      return;
                    }
                  }
                } while (dirty && !closed && !streamSignal.aborted);
              } catch {
                cleanup();
                return;
              } finally {
                pumping = false;
                if (!closed && !streamSignal.aborted) {
                  if (pausedForBackpressure || isBackpressured()) {
                    pausedForBackpressure = true;
                    armBackpressureTimeout();
                  } else {
                    clearBackpressureTimeout();
                    if (dirty) {
                      void drainPending();
                    } else {
                      schedulePollTimer();
                    }
                  }
                }
              }
            };
            drainPendingFn = drainPending;

            onAbort = () => cleanup();
            streamSignal.addEventListener("abort", onAbort, { once: true });
            if (streamSignal.aborted) {
              cleanup();
              return;
            }

            if (!enqueueFrame(`retry: ${retryMs}\n\n`)) {
              return;
            }
            if (open.mode === "resync") {
              if (
                !enqueueSseEvent(
                  "resync",
                  {
                    contractVersion: CONTRACT_VERSION,
                    type: "resync",
                    workspaceId,
                    projectId,
                    reason: open.reason,
                    cursor: open.cursor,
                  },
                  open.cursor,
                )
              ) {
                return;
              }
            } else {
              if (
                !enqueueSseEvent(
                  "ready",
                  {
                    contractVersion: CONTRACT_VERSION,
                    type: "ready",
                    workspaceId,
                    projectId,
                    cursor: open.cursor,
                  },
                  open.cursor,
                )
              ) {
                return;
              }
            }

            unsubscribeHub = deps.realtimeHub?.subscribe(workspaceId, () => {
              if (isBackpressured()) {
                pausedForBackpressure = true;
                dirty = true;
                armBackpressureTimeout();
                return;
              }
              if (pollTimer !== undefined) {
                clearTimeout(pollTimer);
                pollTimer = undefined;
              }
              void drainPending();
            });

            heartbeatTimer = setInterval(() => {
              if (isBackpressured()) {
                pausedForBackpressure = true;
                armBackpressureTimeout();
                return;
              }
              enqueueFrame(": keepalive\n\n");
            }, heartbeatIntervalMs);

            if (!closed && !streamSignal.aborted) {
              if (isBackpressured()) {
                pausedForBackpressure = true;
                if (open.mode === "resume") {
                  dirty = true;
                }
                armBackpressureTimeout();
              } else if (open.mode === "resume") {
                void drainPending();
              } else {
                schedulePollTimer();
              }
            }
          },

          pull() {
            if (closed || streamSignal.aborted) {
              return;
            }
            if (!isBackpressured()) {
              clearBackpressureTimeout();
              if (pausedForBackpressure) {
                pausedForBackpressure = false;
                void drainPendingFn?.();
              } else {
                schedulePollFn?.();
              }
            }
          },

          cancel() {
            closed = true;
            if (pollTimer !== undefined) {
              clearTimeout(pollTimer);
              pollTimer = undefined;
            }
            if (heartbeatTimer !== undefined) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = undefined;
            }
            clearBackpressureTimeout();
            unsubscribeHub?.();
            unsubscribeHub = undefined;
            if (onAbort) {
              streamSignal.removeEventListener("abort", onAbort);
              onAbort = undefined;
            }
          },
        },
        {
          highWaterMark: maxBufferedBytes,
          size(chunk) {
            return chunk.byteLength;
          },
        },
      );

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-store, no-transform",
          "X-Accel-Buffering": "no",
        },
      });
    });
  }

  return app;
}
