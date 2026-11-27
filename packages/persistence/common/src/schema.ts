export interface SchemaMigrationTable {
  version: number;
  name: string;
  applied_at: string;
}

export interface WorkspaceTable {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceSettingsTable {
  workspace_id: string;
  default_locale: string;
  dev_projects_enabled: number;
  updated_at: string;
}

export interface ProodDatabase {
  prood_schema_migrations: SchemaMigrationTable;
  workspaces: WorkspaceTable;
  workspace_settings: WorkspaceSettingsTable;
}
