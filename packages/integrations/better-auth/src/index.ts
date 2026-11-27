import { betterAuth } from "better-auth";
import type { AuthPort, AuthSessionInfo } from "@prood/application";
import type { KyselyBackedDatabaseClient } from "@prood/persistence-common";

export interface BetterAuthAdapterOptions {
  db: KyselyBackedDatabaseClient;
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
}

/**
 * Wraps Better Auth (Email + Password) over Prood's shared Kysely DB connection.
 */
export function createBetterAuthAdapter(
  options: BetterAuthAdapterOptions,
): AuthPort {
  const auth = betterAuth({
    database: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: options.db.kysely as any,
      type: options.db.driver,
    },
    secret: options.secret,
    baseURL: options.baseURL,
    trustedOrigins: options.trustedOrigins,
    emailAndPassword: {
      enabled: true,
    },
    user: {
      modelName: "auth_user",
    },
    session: {
      modelName: "auth_session",
    },
    account: {
      modelName: "auth_account",
    },
    verification: {
      modelName: "auth_verification",
    },
  });

  return {
    async handler(request: Request): Promise<Response> {
      return auth.handler(request);
    },

    async getSession(headers: Headers): Promise<AuthSessionInfo | null> {
      const result = await auth.api.getSession({ headers });
      if (!result || !result.session || !result.user) {
        return null;
      }
      const rawExpiresAt = result.session.expiresAt as Date | string;
      const expiresAt =
        rawExpiresAt instanceof Date
          ? rawExpiresAt.toISOString()
          : String(rawExpiresAt);

      return {
        sessionId: result.session.id,
        authProvider: "better-auth",
        authSubject: result.user.id,
        email: result.user.email,
        name: result.user.name,
        expiresAt,
      };
    },
  };
}
