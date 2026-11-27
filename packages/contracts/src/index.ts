import type {
  LocaleCode,
  MembershipId,
  UserId,
  WorkspaceId,
  WorkspaceRole,
} from "@prood/domain";

export const CONTRACT_VERSION = 1 as const;

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "INTERNAL_ERROR";

export type DbDriverKind = "postgres" | "sqlite";

export interface HealthResponse {
  contractVersion: typeof CONTRACT_VERSION;
  status: "ok";
  dbDriver: DbDriverKind;
  locale: LocaleCode;
  timestamp: string;
}

export interface AuthUserSummary {
  id: UserId;
  email: string;
  displayName: string;
}

export interface WorkspaceMembershipSummary {
  membershipId: MembershipId;
  workspaceId: WorkspaceId;
  workspaceSlug: string;
  workspaceName: string;
  role: WorkspaceRole;
}

export interface MeResponse {
  contractVersion: typeof CONTRACT_VERSION;
  user: AuthUserSummary;
  memberships: WorkspaceMembershipSummary[];
}

export interface WorkspaceMembershipResponse {
  contractVersion: typeof CONTRACT_VERSION;
  workspace: {
    id: WorkspaceId;
    slug: string;
    name: string;
  };
  membership: {
    id: MembershipId;
    role: WorkspaceRole;
  };
}

export interface ApiErrorResponse {
  contractVersion: typeof CONTRACT_VERSION;
  error: {
    code: ApiErrorCode;
    messageKey: string;
  };
}

export const MCP_REQUIRED_WHOAMI_SCOPE = "prood:read" as const;

export interface McpWhoamiResponse {
  contractVersion: typeof CONTRACT_VERSION;
  userId: UserId;
  email: string;
  displayName: string;
  clientId: string;
  scopes: string[];
  resource: string;
  workspaces: WorkspaceMembershipSummary[];
}
