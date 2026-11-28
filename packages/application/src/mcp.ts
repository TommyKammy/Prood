import {
  CONTRACT_VERSION,
  type McpWhoamiResponse,
  type WorkspaceMembershipSummary,
} from "@prood/contracts";
import type { AuditActorContext, UserId } from "@prood/domain";
import { createIdentityUseCases } from "./auth.js";
import type { IdGenerator } from "./id.js";
import type { Clock } from "./index.js";
import type { UnitOfWork, UserRecord } from "./persistence.js";

export interface McpVerifiedToken {
  subject: string;
  clientId: string;
  scopes: string[];
  audience: string | string[];
  expiresAt: number;
  issuer: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
}

export type McpTokenVerificationResult =
  | { ok: true; token: McpVerifiedToken }
  | {
      ok: false;
      status: 401 | 403;
      error: "invalid_token" | "insufficient_scope";
      description: string;
      requiredScope?: string;
    };

/**
 * Token verification & OAuth discovery port implemented by the Better Auth adapter.
 */
export interface McpTokenVerifier {
  verifyBearerToken(
    headers: Headers,
    options?: { requiredScopes?: string[] },
  ): Promise<McpTokenVerificationResult>;
  getProtectedResourceMetadata(): Record<string, unknown>;
  getAuthorizationServerMetadata(): Promise<Record<string, unknown>>;
}

/**
 * Web-Standard MCP HTTP transport handler mounted at `/mcp`.
 */
export interface McpHttpHandler {
  handleRequest(request: Request): Promise<Response>;
  close?(): Promise<void>;
}

export interface McpIdentityUseCaseDeps {
  uow: UnitOfWork;
  idGenerator: IdGenerator;
  clock: Clock;
}

export function createMcpIdentityUseCase(deps: McpIdentityUseCaseDeps) {
  const identityUseCases = createIdentityUseCases(deps);

  async function resolveUser(
    token: McpVerifiedToken,
    includeWorkspaces: boolean,
  ): Promise<{ user: UserRecord; workspaces: WorkspaceMembershipSummary[] }> {
    const existing = await deps.uow.run(async (repos) => {
      const user = await repos.users.findByAuthIdentity(
        "better-auth",
        token.subject,
      );
      if (!user) {
        return null;
      }
      const workspaces = includeWorkspaces
        ? await repos.memberships.listSummariesForUser(user.id)
        : [];
      return { user, workspaces };
    });

    if (existing) {
      return existing;
    }

    if (!token.email) {
      throw new Error(
        `No Prood user linked for subject "${token.subject}" and no email claim available`,
      );
    }

    const profile = await identityUseCases.getCurrentUserProfile({
      sessionId: `mcp:${token.clientId}`,
      authProvider: "better-auth",
      authSubject: token.subject,
      email: token.email,
      emailVerified: token.emailVerified,
      name: token.name ?? token.email,
      expiresAt: new Date(token.expiresAt * 1000).toISOString(),
    });

    return {
      user: {
        id: profile.user.id as UserId,
        email: profile.user.email,
        displayName: profile.user.displayName,
        createdAt: "",
        updatedAt: "",
      },
      workspaces: profile.memberships,
    };
  }

  return {
    async resolveActor(token: McpVerifiedToken): Promise<AuditActorContext> {
      const { user } = await resolveUser(token, false);
      return {
        userId: user.id,
        actorType: "agent",
        channel: "mcp",
        clientId: token.clientId,
      };
    },

    async whoami(
      token: McpVerifiedToken,
      resource: string,
    ): Promise<McpWhoamiResponse> {
      const { user, workspaces } = await resolveUser(token, true);
      return {
        contractVersion: CONTRACT_VERSION,
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        clientId: token.clientId,
        scopes: [...token.scopes],
        resource,
        workspaces,
      };
    },
  };
}
