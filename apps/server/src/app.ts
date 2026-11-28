import { Hono, type Context } from "hono";
import {
  createHealthCheckUseCase,
  createIdentityUseCases,
  createWorkUseCases,
  isEmailVerificationRequiredError,
  type AuthPort,
  type AuthSessionInfo,
  type Clock,
  type DatabaseHealthPort,
  type IdGenerator,
  type McpHttpHandler,
  type McpTokenVerifier,
  type UnitOfWork,
  type WorkUseCaseResult,
} from "@prood/application";
import {
  CONTRACT_VERSION,
  type ApiErrorResponse,
  type CopyTaskRequest,
  type CreateProjectRequest,
  type CreateTaskRequest,
  type EnableDevProjectRequest,
  type MoveTaskRequest,
  type UpdateDevProjectSettingsRequest,
  type UpdateTaskRequest,
  type UpdateWorkspaceSettingsRequest,
} from "@prood/contracts";
import {
  isValidEntityId,
  type AuditActorContext,
  type LocaleCode,
  type WorkspaceId,
} from "@prood/domain";

export interface AppDeps {
  clock: Clock;
  dbHealth: DatabaseHealthPort;
  locale?: LocaleCode;
  auth?: AuthPort;
  uow?: UnitOfWork;
  idGenerator?: IdGenerator;
  mcpAuth?: McpTokenVerifier;
  mcpHandler?: McpHttpHandler;
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
  }

  return app;
}
