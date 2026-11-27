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
];
