import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import {
  oauthProvider,
  oauthProviderAuthServerMetadata,
} from "@better-auth/oauth-provider";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type {
  AuthPort,
  AuthSessionInfo,
  McpTokenVerificationResult,
  McpTokenVerifier,
} from "@prood/application";
import { MCP_REQUIRED_WHOAMI_SCOPE } from "@prood/contracts";
import type { KyselyBackedDatabaseClient } from "@prood/persistence-common";

export const DEFAULT_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  MCP_REQUIRED_WHOAMI_SCOPE,
  "prood:write",
] as const;

const JWKS_CACHE_TTL_MS = 60_000;

export interface BetterAuthAdapterOptions {
  db: KyselyBackedDatabaseClient;
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
  mcpResource?: string;
  extraValidAudiences?: string[];
  scopes?: string[];
  accessTokenExpiresIn?: number;
}

export type BetterAuthCombinedAdapter = AuthPort & McpTokenVerifier;

function parseScopes(rawScope: unknown): string[] {
  if (typeof rawScope === "string") {
    return rawScope
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(rawScope)) {
    return rawScope.map((s) => String(s)).filter(Boolean);
  }
  return [];
}

function isJoseVerificationError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return (
    typeof code === "string" &&
    (code.startsWith("ERR_JW") || code.startsWith("ERR_JWS") || code.startsWith("ERR_JWE"))
  );
}

/**
 * Wraps Better Auth (Email + Password + OAuth 2.1 Provider + JWT/JWKS)
 * over Prood's shared Kysely DB connection.
 */
export function createBetterAuthAdapter(
  options: BetterAuthAdapterOptions,
): BetterAuthCombinedAdapter {
  const normalizedBaseUrl = options.baseURL.replace(/\/+$/, "");
  const mcpResource = options.mcpResource ?? `${normalizedBaseUrl}/mcp`;
  const scopes = options.scopes ?? [...DEFAULT_OAUTH_SCOPES];
  const configuredResources = Array.from(
    new Set([mcpResource, ...(options.extraValidAudiences ?? [])]),
  );
  const issuer = `${normalizedBaseUrl}/api/auth`;

  const auth = betterAuth({
    database: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: options.db.kysely as any,
      type: options.db.driver,
    },
    secret: options.secret,
    baseURL: normalizedBaseUrl,
    trustedOrigins: options.trustedOrigins,
    disabledPaths: ["/token"],
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
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: "/",
        consentPage: "/oauth/consent",
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        scopes,
        validAudiences: configuredResources,
        resources: configuredResources,
        clientRegistrationDefaultResources: configuredResources,
        clientRegistrationDefaultScopes: scopes,
        clientRegistrationAllowedScopes: scopes,
        enforcePerClientResources: false,
        ...(options.accessTokenExpiresIn !== undefined
          ? { accessTokenExpiresIn: options.accessTokenExpiresIn }
          : {}),
        allowInsecureRedirectUri: (url) =>
          url.protocol === "http:" &&
          (url.hostname === "127.0.0.1" ||
            url.hostname === "localhost" ||
            url.hostname === "::1" ||
            url.hostname === "[::1]"),
      }),
    ],
  });

  const authServerMetadataHandler = oauthProviderAuthServerMetadata(auth);

  let cachedJwks: ReturnType<typeof createLocalJWKSet> | null = null;
  let cachedJwksExpiresAtMs = 0;
  let cachedExpectedIssuer: string | null = null;

  async function getLocalJwks(
    forceRefresh = false,
  ): Promise<ReturnType<typeof createLocalJWKSet>> {
    const nowMs = Date.now();
    if (!forceRefresh && cachedJwks && nowMs < cachedJwksExpiresAtMs) {
      return cachedJwks;
    }
    const jwksResponse = await auth.handler(
      new Request(`${normalizedBaseUrl}/api/auth/jwks`, { method: "GET" }),
    );
    if (!jwksResponse.ok) {
      throw new Error(`Failed to load local JWKS (${jwksResponse.status})`);
    }
    const jwksBody = (await jwksResponse.json()) as JSONWebKeySet;
    cachedJwks = createLocalJWKSet(jwksBody);
    cachedJwksExpiresAtMs = nowMs + JWKS_CACHE_TTL_MS;
    return cachedJwks;
  }

  async function getAuthorizationServerMetadata(): Promise<Record<string, unknown>> {
    const res = await authServerMetadataHandler(
      new Request(`${normalizedBaseUrl}/.well-known/oauth-authorization-server`, {
        method: "GET",
      }),
    );
    return (await res.json()) as Record<string, unknown>;
  }

  async function getExpectedIssuer(): Promise<string> {
    if (cachedExpectedIssuer) {
      return cachedExpectedIssuer;
    }
    const metadata = await getAuthorizationServerMetadata();
    cachedExpectedIssuer =
      typeof metadata.issuer === "string" ? metadata.issuer : issuer;
    return cachedExpectedIssuer;
  }

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
        emailVerified: Boolean(result.user.emailVerified),
        name: result.user.name,
        expiresAt,
      };
    },

    getProtectedResourceMetadata(): Record<string, unknown> {
      return {
        resource: mcpResource,
        authorization_servers: [issuer],
        scopes_supported: scopes,
        bearer_methods_supported: ["header"],
      };
    },

    getAuthorizationServerMetadata,

    async verifyBearerToken(
      headers: Headers,
      verifyOptions?: { requiredScopes?: string[] },
    ): Promise<McpTokenVerificationResult> {
      const authHeader = headers.get("authorization");
      if (!authHeader) {
        return {
          ok: false,
          status: 401,
          error: "invalid_token",
          description: "Missing Authorization header",
        };
      }

      const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      if (!match?.[1]) {
        return {
          ok: false,
          status: 401,
          error: "invalid_token",
          description: "Authorization header must use Bearer scheme",
        };
      }
      const rawToken = match[1].trim();

      let verifiedPayload: Record<string, unknown>;
      try {
        const expectedIssuer = await getExpectedIssuer();
        let jwks = await getLocalJwks();
        try {
          const { payload } = await jwtVerify(rawToken, jwks, {
            issuer: expectedIssuer,
            audience: mcpResource,
            typ: "at+jwt",
            requiredClaims: ["exp", "sub"],
          });
          verifiedPayload = payload as Record<string, unknown>;
        } catch (verifyErr) {
          if (
            (verifyErr as { code?: unknown })?.code === "ERR_JWKS_NO_MATCHING_KEY"
          ) {
            jwks = await getLocalJwks(true);
            const { payload } = await jwtVerify(rawToken, jwks, {
              issuer: expectedIssuer,
              audience: mcpResource,
              typ: "at+jwt",
              requiredClaims: ["exp", "sub"],
            });
            verifiedPayload = payload as Record<string, unknown>;
          } else {
            throw verifyErr;
          }
        }
      } catch (error) {
        if (isJoseVerificationError(error)) {
          return {
            ok: false,
            status: 401,
            error: "invalid_token",
            description:
              error instanceof Error ? error.message : "Invalid or expired token",
          };
        }
        return {
          ok: false,
          status: 401,
          error: "invalid_token",
          description: "Token verification failed",
        };
      }

      if (verifiedPayload.cnf !== undefined) {
        return {
          ok: false,
          status: 401,
          error: "invalid_token",
          description: "Sender-constrained DPoP tokens cannot be used as Bearer tokens",
        };
      }

      const subject =
        typeof verifiedPayload.sub === "string" ? verifiedPayload.sub : "";
      if (!subject) {
        return {
          ok: false,
          status: 401,
          error: "invalid_token",
          description: "Access token missing sub claim",
        };
      }

      const tokenScopes = parseScopes(verifiedPayload.scope);
      const requiredScopes = verifyOptions?.requiredScopes ?? [];
      const missingScopes = requiredScopes.filter(
        (scope) => !tokenScopes.includes(scope),
      );
      if (missingScopes.length > 0) {
        const requiredScope = missingScopes.join(" ");
        return {
          ok: false,
          status: 403,
          error: "insufficient_scope",
          description: `Missing required scope: ${requiredScope}`,
          requiredScope,
        };
      }

      let authUser:
        | { email: string; name: string; emailVerified: number | boolean }
        | undefined;
      try {
        authUser = await options.db.kysely
          .selectFrom("auth_user")
          .select(["email", "name", "emailVerified"])
          .where("id", "=", subject)
          .executeTakeFirst();

        if (!authUser) {
          return {
            ok: false,
            status: 401,
            error: "invalid_token",
            description: "Access token subject is no longer active",
          };
        }

        const tokenSid =
          typeof verifiedPayload.sid === "string" ? verifiedPayload.sid : "";
        if (tokenSid) {
          const authSession = await options.db.kysely
            .selectFrom("auth_session")
            .select(["id", "expiresAt"])
            .where("id", "=", tokenSid)
            .executeTakeFirst();
          if (
            !authSession ||
            new Date(authSession.expiresAt).getTime() <= Date.now()
          ) {
            return {
              ok: false,
              status: 401,
              error: "invalid_token",
              description: "Session has been revoked or expired",
            };
          }
        }

        const clientIdForLookup =
          typeof verifiedPayload.client_id === "string"
            ? verifiedPayload.client_id
            : typeof verifiedPayload.azp === "string"
              ? verifiedPayload.azp
              : "";
        if (clientIdForLookup) {
          const oauthClient = await options.db.kysely
            .selectFrom("oauthClient")
            .select(["clientId", "disabled"])
            .where("clientId", "=", clientIdForLookup)
            .executeTakeFirst();
          if (!oauthClient || Boolean(oauthClient.disabled)) {
            return {
              ok: false,
              status: 401,
              error: "invalid_token",
              description: "OAuth client is disabled or revoked",
            };
          }
        }
      } catch {
        return {
          ok: false,
          status: 401,
          error: "invalid_token",
          description: "Token verification failed",
        };
      }

      const clientId =
        typeof verifiedPayload.client_id === "string"
          ? verifiedPayload.client_id
          : typeof verifiedPayload.azp === "string"
            ? verifiedPayload.azp
            : "unknown";

      const audience = Array.isArray(verifiedPayload.aud)
        ? verifiedPayload.aud.map(String)
        : typeof verifiedPayload.aud === "string"
          ? verifiedPayload.aud
          : mcpResource;

      return {
        ok: true,
        token: {
          subject,
          clientId,
          scopes: tokenScopes,
          audience,
          expiresAt:
            typeof verifiedPayload.exp === "number" ? verifiedPayload.exp : 0,
          issuer:
            typeof verifiedPayload.iss === "string"
              ? verifiedPayload.iss
              : issuer,
          email: authUser.email,
          emailVerified: Boolean(authUser.emailVerified),
          name: authUser.name,
        },
      };
    },
  };
}
