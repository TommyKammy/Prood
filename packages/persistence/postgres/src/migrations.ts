import type { MigrationDefinition } from "@prood/persistence-common";

export const POSTGRES_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    version: 1,
    name: "0001_init_workspaces",
    statements: [
      `CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: "0002_init_workspace_settings",
    statements: [
      `CREATE TABLE IF NOT EXISTS workspace_settings (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        default_locale TEXT NOT NULL DEFAULT 'en',
        dev_projects_enabled INTEGER NOT NULL DEFAULT 0 CHECK (dev_projects_enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      )`,
      `INSERT INTO workspace_settings (workspace_id, default_locale, dev_projects_enabled, updated_at)
       SELECT id, 'en', 0, created_at
       FROM workspaces
       WHERE NOT EXISTS (
         SELECT 1 FROM workspace_settings ws WHERE ws.workspace_id = workspaces.id
       )`,
    ],
  },
  {
    version: 3,
    name: "0003_init_auth_and_users",
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_user (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "email" TEXT NOT NULL UNIQUE,
        "emailVerified" BOOLEAN NOT NULL,
        "image" TEXT,
        "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS auth_session (
        "id" TEXT NOT NULL PRIMARY KEY,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "token" TEXT NOT NULL UNIQUE,
        "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL,
        "ipAddress" TEXT,
        "userAgent" TEXT,
        "userId" TEXT NOT NULL REFERENCES auth_user("id") ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS auth_session_userId_idx ON auth_session ("userId")`,
      `CREATE TABLE IF NOT EXISTS auth_account (
        "id" TEXT NOT NULL PRIMARY KEY,
        "accountId" TEXT NOT NULL,
        "providerId" TEXT NOT NULL,
        "userId" TEXT NOT NULL REFERENCES auth_user("id") ON DELETE CASCADE,
        "accessToken" TEXT,
        "refreshToken" TEXT,
        "idToken" TEXT,
        "accessTokenExpiresAt" TIMESTAMPTZ,
        "refreshTokenExpiresAt" TIMESTAMPTZ,
        "scope" TEXT,
        "password" TEXT,
        "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS auth_account_userId_idx ON auth_account ("userId")`,
      `CREATE TABLE IF NOT EXISTS auth_verification (
        "id" TEXT NOT NULL PRIMARY KEY,
        "identifier" TEXT NOT NULL,
        "value" TEXT NOT NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS auth_verification_identifier_idx ON auth_verification ("identifier")`,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS auth_identities (
        auth_provider TEXT NOT NULL,
        auth_subject TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (auth_provider, auth_subject)
      )`,
      `CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx ON auth_identities (user_id)`,
      `CREATE TABLE IF NOT EXISTS workspace_memberships (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS workspace_memberships_user_id_idx ON workspace_memberships (user_id)`,
    ],
  },
  {
    version: 4,
    name: "0004_init_oauth_provider",
    statements: [
      `CREATE TABLE IF NOT EXISTS "jwks" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "publicKey" TEXT NOT NULL,
        "privateKey" TEXT NOT NULL,
        "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "expiresAt" TIMESTAMPTZ,
        "alg" TEXT,
        "crv" TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS "oauthClient" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "clientId" TEXT NOT NULL UNIQUE,
        "clientSecret" TEXT,
        "clientDiscoveryId" TEXT,
        "disabled" BOOLEAN,
        "skipConsent" BOOLEAN,
        "enableEndSession" BOOLEAN,
        "subjectType" TEXT,
        "scopes" JSONB,
        "clientCredentialsScopes" JSONB,
        "userId" TEXT REFERENCES "auth_user"("id") ON DELETE CASCADE,
        "createdAt" TIMESTAMPTZ,
        "updatedAt" TIMESTAMPTZ,
        "name" TEXT,
        "uri" TEXT,
        "icon" TEXT,
        "contacts" JSONB,
        "tos" TEXT,
        "policy" TEXT,
        "softwareId" TEXT,
        "softwareVersion" TEXT,
        "softwareStatement" TEXT,
        "redirectUris" JSONB NOT NULL,
        "postLogoutRedirectUris" JSONB,
        "backchannelLogoutUri" TEXT,
        "backchannelLogoutSessionRequired" BOOLEAN,
        "tokenEndpointAuthMethod" TEXT,
        "applicationType" TEXT,
        "jwks" TEXT,
        "jwksUri" TEXT,
        "grantTypes" JSONB,
        "responseTypes" JSONB,
        "requirePKCE" BOOLEAN,
        "dpopBoundAccessTokens" BOOLEAN,
        "referenceId" TEXT,
        "metadata" JSONB
      )`,
      `CREATE INDEX IF NOT EXISTS "oauthClient_userId_idx" ON "oauthClient" ("userId")`,
      `CREATE TABLE IF NOT EXISTS "oauthResource" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "identifier" TEXT NOT NULL UNIQUE,
        "name" TEXT NOT NULL,
        "accessTokenTtl" INTEGER,
        "refreshTokenTtl" INTEGER,
        "signingAlgorithm" TEXT,
        "signingKeyId" TEXT,
        "allowedScopes" JSONB,
        "customClaims" JSONB,
        "dpopBoundAccessTokensRequired" BOOLEAN,
        "disabled" BOOLEAN,
        "createdAt" TIMESTAMPTZ,
        "updatedAt" TIMESTAMPTZ,
        "policyVersion" INTEGER,
        "metadata" JSONB
      )`,
      `CREATE TABLE IF NOT EXISTS "oauthClientResource" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
        "resourceId" TEXT NOT NULL REFERENCES "oauthResource"("identifier") ON DELETE CASCADE,
        "metadata" JSONB,
        "createdAt" TIMESTAMPTZ
      )`,
      `CREATE INDEX IF NOT EXISTS "oauthClientResource_clientId_idx" ON "oauthClientResource" ("clientId")`,
      `CREATE INDEX IF NOT EXISTS "oauthClientResource_resourceId_idx" ON "oauthClientResource" ("resourceId")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "oauthClientResource_clientId_resourceId_uidx" ON "oauthClientResource" ("clientId", "resourceId")`,
      `CREATE TABLE IF NOT EXISTS "oauthRefreshToken" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "token" TEXT NOT NULL UNIQUE,
        "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
        "sessionId" TEXT REFERENCES "auth_session"("id") ON DELETE SET NULL,
        "userId" TEXT NOT NULL REFERENCES "auth_user"("id") ON DELETE CASCADE,
        "referenceId" TEXT,
        "authorizationCodeId" TEXT,
        "resources" JSONB,
        "requestedUserInfoClaims" JSONB,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL,
        "revoked" TIMESTAMPTZ,
        "rotatedAt" TIMESTAMPTZ,
        "rotationReplayResponse" TEXT,
        "rotationReplayExpiresAt" TIMESTAMPTZ,
        "authTime" TIMESTAMPTZ,
        "confirmation" JSONB,
        "scopes" JSONB NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken" ("clientId")`,
      `CREATE INDEX IF NOT EXISTS "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken" ("sessionId")`,
      `CREATE INDEX IF NOT EXISTS "oauthRefreshToken_userId_idx" ON "oauthRefreshToken" ("userId")`,
      `CREATE INDEX IF NOT EXISTS "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken" ("authorizationCodeId")`,
      `CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "token" TEXT NOT NULL UNIQUE,
        "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
        "sessionId" TEXT REFERENCES "auth_session"("id") ON DELETE SET NULL,
        "userId" TEXT REFERENCES "auth_user"("id") ON DELETE CASCADE,
        "referenceId" TEXT,
        "authorizationCodeId" TEXT,
        "resources" JSONB,
        "requestedUserInfoClaims" JSONB,
        "refreshId" TEXT REFERENCES "oauthRefreshToken"("id") ON DELETE CASCADE,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL,
        "revoked" TIMESTAMPTZ,
        "confirmation" JSONB,
        "scopes" JSONB NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId")`,
      `CREATE INDEX IF NOT EXISTS "oauthAccessToken_sessionId_idx" ON "oauthAccessToken" ("sessionId")`,
      `CREATE INDEX IF NOT EXISTS "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId")`,
      `CREATE INDEX IF NOT EXISTS "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken" ("authorizationCodeId")`,
      `CREATE INDEX IF NOT EXISTS "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" ("refreshId")`,
      `CREATE TABLE IF NOT EXISTS "oauthConsent" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
        "userId" TEXT REFERENCES "auth_user"("id") ON DELETE CASCADE,
        "referenceId" TEXT,
        "resources" JSONB,
        "requestedUserInfoClaims" JSONB,
        "scopes" JSONB NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId")`,
      `CREATE INDEX IF NOT EXISTS "oauthConsent_userId_idx" ON "oauthConsent" ("userId")`,
      `CREATE TABLE IF NOT EXISTS "oauthClientAssertion" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "expiresAt" TIMESTAMPTZ NOT NULL
      )`,
    ],
  },
];
