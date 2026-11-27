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
  type CreateProjectRequest,
  type CreateTaskRequest,
  type UpdateTaskRequest,
} from "@prood/contracts";
import {
  isValidEntityId,
  type AuditActorContext,
  type LocaleCode,
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

    async function resolveActor(
      session: AuthSessionInfo,
    ): Promise<AuditActorContext> {
      const user = await identityUseCases!.resolveProodUser(session);
      return {
        userId: user.id,
        actorType: "user",
        channel: "web",
      };
    }

    async function parseJsonBody<T>(c: Context): Promise<T | null> {
      try {
        return (await c.req.json()) as T;
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
      const body = await parseJsonBody<CreateProjectRequest>(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      try {
        const actor = await resolveActor(session);
        const result = await workUseCases.createProject(actor, workspaceId, body);
        if (!result.ok) {
          return c.json(errorBody(result.code, result.messageKey), result.status);
        }
        return c.json(result.data, 201);
      } catch (error) {
        if (isEmailVerificationRequiredError(error)) {
          return c.json(
            errorBody("FORBIDDEN", "error.emailVerificationRequired"),
            403,
          );
        }
        throw error;
      }
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
      const actor = await resolveActor(session);
      const result = await workUseCases.listProjects(actor, workspaceId);
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
      const body = await parseJsonBody<CreateTaskRequest>(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const actor = await resolveActor(session);
      const result = await workUseCases.createTask(actor, projectId, body);
      if (!result.ok) {
        return c.json(errorBody(result.code, result.messageKey), result.status);
      }
      return c.json(result.data, 201);
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
      const actor = await resolveActor(session);
      const result = await workUseCases.listProjectTasks(actor, projectId);
      return sendWorkResult(c, result);
    });

    app.get("/api/v1/tasks/:taskId", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const taskId = c.req.param("taskId");
      if (!isValidEntityId("tsk", taskId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const actor = await resolveActor(session);
      const result = await workUseCases.getTask(actor, taskId);
      return sendWorkResult(c, result);
    });

    app.patch("/api/v1/tasks/:taskId", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireSessionOrRecord(c);
      if (!session) {
        return c.json(errorBody("UNAUTHORIZED", "error.unauthorized"), 401);
      }
      if (!identityUseCases || !workUseCases) {
        return c.json(errorBody("INTERNAL_ERROR", "error.generic"), 500);
      }
      const taskId = c.req.param("taskId");
      if (!isValidEntityId("tsk", taskId)) {
        return c.json(errorBody("NOT_FOUND", "error.notFound"), 404);
      }
      const body = await parseJsonBody<UpdateTaskRequest & Record<string, unknown>>(c);
      if (!body) {
        return c.json(errorBody("VALIDATION_ERROR", "error.validation"), 400);
      }
      const actor = await resolveActor(session);
      const result = await workUseCases.updateTask(actor, taskId, body);
      return sendWorkResult(c, result);
    });
  }

  return app;
}
