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
];
