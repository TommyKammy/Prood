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
}
