import { Hono } from "hono";
import {
  createHealthCheckUseCase,
  createIdentityUseCases,
  isEmailVerificationRequiredError,
  type AuthPort,
  type AuthSessionInfo,
  type Clock,
  type DatabaseHealthPort,
  type IdGenerator,
  type McpHttpHandler,
  type McpTokenVerifier,
  type UnitOfWork,
} from "@prood/application";
import {
  CONTRACT_VERSION,
  type ApiErrorResponse,
} from "@prood/contracts";
import { isValidEntityId, type LocaleCode } from "@prood/domain";

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
    app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

    async function requireAuthenticatedSession(
      headers: Headers,
    ): Promise<AuthSessionInfo | null> {
      return auth.getSession(headers);
    }

    const identityUseCases =
      deps.uow && deps.idGenerator
        ? createIdentityUseCases({
            uow: deps.uow,
            idGenerator: deps.idGenerator,
            clock: deps.clock,
          })
        : null;

    app.get("/api/v1/me", async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await requireAuthenticatedSession(c.req.raw.headers);
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
      const session = await requireAuthenticatedSession(c.req.raw.headers);
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
          return c.json(
            errorBody("FORBIDDEN", "error.emailVerificationRequired"),
            403,
          );
        }
        throw error;
      }
    });
  }

  return app;
}
