import {
  CONTRACT_VERSION,
  type MeResponse,
  type WorkspaceMembershipResponse,
} from "@prood/contracts";
import { normalizeEmail, type WorkspaceId } from "@prood/domain";
import type { IdGenerator } from "./id.js";
import type { Clock } from "./index.js";
import type { UnitOfWork, UserRecord } from "./persistence.js";

export interface AuthSessionInfo {
  sessionId: string;
  authProvider: string;
  authSubject: string;
  email: string;
  emailVerified?: boolean;
  name: string;
  expiresAt: string;
}

/**
 * Thrown when an unverified external/sign-up identity attempts to link to a
 * pre-existing Prood user sharing the same email address.
 */
export class EmailVerificationRequiredError extends Error {
  readonly code = "EMAIL_VERIFICATION_REQUIRED" as const;

  constructor(email: string) {
    super(`Email verification required before linking account for ${email}`);
    this.name = "EmailVerificationRequiredError";
  }
}

export function isEmailVerificationRequiredError(
  error: unknown,
): error is EmailVerificationRequiredError {
  return (
    error instanceof EmailVerificationRequiredError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "EMAIL_VERIFICATION_REQUIRED")
  );
}

/**
 * Runtime-independent authentication port implemented by Better Auth adapter.
 */
export interface AuthPort {
  handler(request: Request): Promise<Response>;
  getSession(headers: Headers): Promise<AuthSessionInfo | null>;
}

export interface IdentityUseCaseDeps {
  uow: UnitOfWork;
  idGenerator: IdGenerator;
  clock: Clock;
}

function isUniqueViolationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "UNIQUE_VIOLATION"
  );
}

export function createIdentityUseCases(deps: IdentityUseCaseDeps) {
  async function resolveUserInTx(
    session: AuthSessionInfo,
  ): Promise<UserRecord> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await deps.uow.run(async (repos) => {
          const existingByIdentity = await repos.users.findByAuthIdentity(
            session.authProvider,
            session.authSubject,
          );
          if (existingByIdentity) {
            return existingByIdentity;
          }

          const email = normalizeEmail(session.email);
          let user = await repos.users.findByEmail(email);
          const nowIso = deps.clock.now().toISOString();

          if (user) {
            if (session.emailVerified !== true) {
              throw new EmailVerificationRequiredError(email);
            }
          } else {
            const displayName = session.name.trim() || email;
            user = await repos.users.create({
              id: deps.idGenerator.next("usr"),
              email,
              displayName,
              createdAt: nowIso,
            });
          }

          await repos.users.linkAuthIdentity({
            authProvider: session.authProvider,
            authSubject: session.authSubject,
            userId: user.id,
            createdAt: nowIso,
          });

          return user;
        });
      } catch (error) {
        if (!isUniqueViolationError(error) || attempt >= 2) {
          throw error;
        }
      }
    }
    throw new Error("Unreachable: failed to resolve Prood user");
  }

  return {
    resolveProodUser: resolveUserInTx,

    async getCurrentUserProfile(session: AuthSessionInfo): Promise<MeResponse> {
      const user = await resolveUserInTx(session);
      const memberships = await deps.uow.run((repos) =>
        repos.memberships.listSummariesForUser(user.id),
      );
      return {
        contractVersion: CONTRACT_VERSION,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
        },
        memberships,
      };
    },

    async getWorkspaceMembershipForUser(
      session: AuthSessionInfo,
      workspaceId: WorkspaceId,
    ): Promise<WorkspaceMembershipResponse | null> {
      const user = await resolveUserInTx(session);
      return deps.uow.run(async (repos) => {
        const workspace = await repos.workspaces.findById(workspaceId);
        if (!workspace) {
          return null;
        }
        const membership = await repos.memberships.findByWorkspaceAndUser(
          workspaceId,
          user.id,
        );
        if (!membership) {
          return null;
        }
        return {
          contractVersion: CONTRACT_VERSION,
          workspace: {
            id: workspace.id,
            slug: workspace.slug,
            name: workspace.name,
          },
          membership: {
            id: membership.id,
            role: membership.role,
          },
        };
      });
    },
  };
}
