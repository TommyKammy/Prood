import type { MigrationDefinition } from "@prood/persistence-common";

export const SQLITE_MIGRATIONS: readonly MigrationDefinition[] = [
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
        id TEXT NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        emailVerified INTEGER NOT NULL,
        image TEXT,
        createdAt DATE NOT NULL,
        updatedAt DATE NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS auth_session (
        id TEXT NOT NULL PRIMARY KEY,
        expiresAt DATE NOT NULL,
        token TEXT NOT NULL UNIQUE,
        createdAt DATE NOT NULL,
        updatedAt DATE NOT NULL,
        ipAddress TEXT,
        userAgent TEXT,
        userId TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS auth_session_userId_idx ON auth_session (userId)`,
      `CREATE TABLE IF NOT EXISTS auth_account (
        id TEXT NOT NULL PRIMARY KEY,
        accountId TEXT NOT NULL,
        providerId TEXT NOT NULL,
        userId TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
        accessToken TEXT,
        refreshToken TEXT,
        idToken TEXT,
        accessTokenExpiresAt DATE,
        refreshTokenExpiresAt DATE,
        scope TEXT,
        password TEXT,
        createdAt DATE NOT NULL,
        updatedAt DATE NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS auth_account_userId_idx ON auth_account (userId)`,
      `CREATE TABLE IF NOT EXISTS auth_verification (
        id TEXT NOT NULL PRIMARY KEY,
        identifier TEXT NOT NULL,
        value TEXT NOT NULL,
        expiresAt DATE NOT NULL,
        createdAt DATE NOT NULL,
        updatedAt DATE NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS auth_verification_identifier_idx ON auth_verification (identifier)`,
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
      `CREATE TABLE IF NOT EXISTS jwks (
        id TEXT NOT NULL PRIMARY KEY,
        publicKey TEXT NOT NULL,
        privateKey TEXT NOT NULL,
        createdAt DATE NOT NULL,
        expiresAt DATE,
        alg TEXT,
        crv TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS oauthClient (
        id TEXT NOT NULL PRIMARY KEY,
        clientId TEXT NOT NULL UNIQUE,
        clientSecret TEXT,
        clientDiscoveryId TEXT,
        disabled INTEGER,
        skipConsent INTEGER,
        enableEndSession INTEGER,
        subjectType TEXT,
        scopes TEXT,
        clientCredentialsScopes TEXT,
        userId TEXT REFERENCES auth_user(id) ON DELETE CASCADE,
        createdAt DATE,
        updatedAt DATE,
        name TEXT,
        uri TEXT,
        icon TEXT,
        contacts TEXT,
        tos TEXT,
        policy TEXT,
        softwareId TEXT,
        softwareVersion TEXT,
        softwareStatement TEXT,
        redirectUris TEXT NOT NULL,
        postLogoutRedirectUris TEXT,
        backchannelLogoutUri TEXT,
        backchannelLogoutSessionRequired INTEGER,
        tokenEndpointAuthMethod TEXT,
        applicationType TEXT,
        jwks TEXT,
        jwksUri TEXT,
        grantTypes TEXT,
        responseTypes TEXT,
        requirePKCE INTEGER,
        dpopBoundAccessTokens INTEGER,
        referenceId TEXT,
        metadata TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS oauthClient_userId_idx ON oauthClient (userId)`,
      `CREATE TABLE IF NOT EXISTS oauthResource (
        id TEXT NOT NULL PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        accessTokenTtl INTEGER,
        refreshTokenTtl INTEGER,
        signingAlgorithm TEXT,
        signingKeyId TEXT,
        allowedScopes TEXT,
        customClaims TEXT,
        dpopBoundAccessTokensRequired INTEGER,
        disabled INTEGER,
        createdAt DATE,
        updatedAt DATE,
        policyVersion INTEGER,
        metadata TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS oauthClientResource (
        id TEXT NOT NULL PRIMARY KEY,
        clientId TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
        resourceId TEXT NOT NULL REFERENCES oauthResource(identifier) ON DELETE CASCADE,
        metadata TEXT,
        createdAt DATE
      )`,
      `CREATE INDEX IF NOT EXISTS oauthClientResource_clientId_idx ON oauthClientResource (clientId)`,
      `CREATE INDEX IF NOT EXISTS oauthClientResource_resourceId_idx ON oauthClientResource (resourceId)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS oauthClientResource_clientId_resourceId_uidx ON oauthClientResource (clientId, resourceId)`,
      `CREATE TABLE IF NOT EXISTS oauthRefreshToken (
        id TEXT NOT NULL PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        clientId TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
        sessionId TEXT REFERENCES auth_session(id) ON DELETE SET NULL,
        userId TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
        referenceId TEXT,
        authorizationCodeId TEXT,
        resources TEXT,
        requestedUserInfoClaims TEXT,
        expiresAt DATE NOT NULL,
        createdAt DATE NOT NULL,
        revoked DATE,
        rotatedAt DATE,
        rotationReplayResponse TEXT,
        rotationReplayExpiresAt DATE,
        authTime DATE,
        confirmation TEXT,
        scopes TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS oauthRefreshToken_clientId_idx ON oauthRefreshToken (clientId)`,
      `CREATE INDEX IF NOT EXISTS oauthRefreshToken_sessionId_idx ON oauthRefreshToken (sessionId)`,
      `CREATE INDEX IF NOT EXISTS oauthRefreshToken_userId_idx ON oauthRefreshToken (userId)`,
      `CREATE INDEX IF NOT EXISTS oauthRefreshToken_authorizationCodeId_idx ON oauthRefreshToken (authorizationCodeId)`,
      `CREATE TABLE IF NOT EXISTS oauthAccessToken (
        id TEXT NOT NULL PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        clientId TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
        sessionId TEXT REFERENCES auth_session(id) ON DELETE SET NULL,
        userId TEXT REFERENCES auth_user(id) ON DELETE CASCADE,
        referenceId TEXT,
        authorizationCodeId TEXT,
        resources TEXT,
        requestedUserInfoClaims TEXT,
        refreshId TEXT REFERENCES oauthRefreshToken(id) ON DELETE CASCADE,
        expiresAt DATE NOT NULL,
        createdAt DATE NOT NULL,
        revoked DATE,
        confirmation TEXT,
        scopes TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS oauthAccessToken_clientId_idx ON oauthAccessToken (clientId)`,
      `CREATE INDEX IF NOT EXISTS oauthAccessToken_sessionId_idx ON oauthAccessToken (sessionId)`,
      `CREATE INDEX IF NOT EXISTS oauthAccessToken_userId_idx ON oauthAccessToken (userId)`,
      `CREATE INDEX IF NOT EXISTS oauthAccessToken_authorizationCodeId_idx ON oauthAccessToken (authorizationCodeId)`,
      `CREATE INDEX IF NOT EXISTS oauthAccessToken_refreshId_idx ON oauthAccessToken (refreshId)`,
      `CREATE TABLE IF NOT EXISTS oauthConsent (
        id TEXT NOT NULL PRIMARY KEY,
        clientId TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
        userId TEXT REFERENCES auth_user(id) ON DELETE CASCADE,
        referenceId TEXT,
        resources TEXT,
        requestedUserInfoClaims TEXT,
        scopes TEXT NOT NULL,
        createdAt DATE NOT NULL,
        updatedAt DATE NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS oauthConsent_clientId_idx ON oauthConsent (clientId)`,
      `CREATE INDEX IF NOT EXISTS oauthConsent_userId_idx ON oauthConsent (userId)`,
      `CREATE TABLE IF NOT EXISTS oauthClientAssertion (
        id TEXT NOT NULL PRIMARY KEY,
        expiresAt DATE NOT NULL
      )`,
    ],
  },
];
