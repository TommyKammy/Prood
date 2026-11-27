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
          (url.hostname === "127.0.0.1" || url.hostname === "localhost"),
      }),
    ],
  });

  const authServerMetadataHandler = oauthProviderAuthServerMetadata(auth);

  async function getLocalJwks(): Promise<ReturnType<typeof createLocalJWKSet>> {
    const jwksResponse = await auth.handler(
      new Request(`${normalizedBaseUrl}/api/auth/jwks`, { method: "GET" }),
    );
    if (!jwksResponse.ok) {
      throw new Error(`Failed to load local JWKS (${jwksResponse.status})`);
    }
    const jwksBody = (await jwksResponse.json()) as JSONWebKeySet;
    return createLocalJWKSet(jwksBody);
  }

  async function getAuthorizationServerMetadata(): Promise<Record<string, unknown>> {
    const res = await authServerMetadataHandler(
      new Request(`${normalizedBaseUrl}/.well-known/oauth-authorization-server`, {
        method: "GET",
      }),
    );
    return (await res.json()) as Record<string, unknown>;
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
        const jwks = await getLocalJwks();
        const metadata = await getAuthorizationServerMetadata();
        const expectedIssuer =
          typeof metadata.issuer === "string" ? metadata.issuer : issuer;

        const { payload } = await jwtVerify(rawToken, jwks, {
          issuer: expectedIssuer,
          audience: mcpResource,
        });
        verifiedPayload = payload as Record<string, unknown>;
      } catch (error) {
        return {
          ok: false,
          status: 401,
          error: "invalid_token",
          description:
            error instanceof Error ? error.message : "Invalid or expired token",
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

      const authUser = await options.db.kysely
        .selectFrom("auth_user")
        .select(["email", "name"])
        .where("id", "=", subject)
        .executeTakeFirst();

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
          email:
            authUser?.email ??
            (typeof verifiedPayload.email === "string"
              ? verifiedPayload.email
              : undefined),
          name:
            authUser?.name ??
            (typeof verifiedPayload.name === "string"
              ? verifiedPayload.name
              : undefined),
        },
      };
    },
  };
}
