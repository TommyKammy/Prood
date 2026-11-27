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

export interface UserTable {
  id: string;
  email: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

export interface AuthIdentityTable {
  auth_provider: string;
  auth_subject: string;
  user_id: string;
  created_at: string;
}

export interface WorkspaceMembershipTable {
  id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  created_at: string;
  updated_at: string;
}

export interface AuthUserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: number | boolean;
  image: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface AuthSessionTable {
  id: string;
  expiresAt: string | Date;
  token: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

export interface JwksTable {
  id: string;
  publicKey: string;
  privateKey: string;
  createdAt: string | Date;
  expiresAt: string | Date | null;
  alg: string | null;
  crv: string | null;
}

export interface OAuthClientTable {
  id: string;
  clientId: string;
  disabled: number | boolean | null;
  name: string | null;
}

export interface ProjectTable {
  id: string;
  workspace_id: string;
  kind: string;
  visibility: string;
  name: string;
  description: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectMembershipTable {
  id: string;
  project_id: string;
  user_id: string;
  role: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectStatusTable {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  category: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface TaskTable {
  id: string;
  workspace_id: string;
  project_id: string | null;
  parent_task_id: string | null;
  status_id: string | null;
  title: string;
  description: string;
  assignee_id: string | null;
  created_by: string | null;
  due_on: string | null;
  completed_at: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface OutboxEventTable {
  id: string;
  event_id: string;
  schema_version: number;
  workspace_id: string | null;
  project_id: string | null;
  event_type: string;
  action: string;
  outcome: string;
  actor_user_id: string | null;
  actor_type: string;
  channel: string;
  target_type: string;
  target_id: string | null;
  reason_code: string | null;
  payload_json: string;
  occurred_at: string;
  delivery_status: string;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface ProodDatabase {
  prood_schema_migrations: SchemaMigrationTable;
  workspaces: WorkspaceTable;
  workspace_settings: WorkspaceSettingsTable;
  users: UserTable;
  auth_identities: AuthIdentityTable;
  workspace_memberships: WorkspaceMembershipTable;
  auth_user: AuthUserTable;
  auth_session: AuthSessionTable;
  jwks: JwksTable;
  oauthClient: OAuthClientTable;
  projects: ProjectTable;
  project_memberships: ProjectMembershipTable;
  project_statuses: ProjectStatusTable;
  tasks: TaskTable;
  outbox_events: OutboxEventTable;
}
