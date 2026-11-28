import type {
  ActorType,
  EventChannel,
  EventId,
  EventOutcome,
  LocaleCode,
  MembershipId,
  NamespaceId,
  OutboxId,
  ProjectId,
  ProjectKind,
  ProjectRole,
  ProjectVisibility,
  StatusCategory,
  StatusId,
  TaskPublicId,
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

export const MCP_READ_SCOPE = "prood:read" as const;
export const MCP_WRITE_SCOPE = "prood:write" as const;
export const MCP_REQUIRED_WHOAMI_SCOPE = MCP_READ_SCOPE;

export interface McpToolErrorPayload {
  contractVersion: typeof CONTRACT_VERSION;
  error: {
    code: ApiErrorCode;
    status: number;
    messageKey: string;
  };
}

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

export interface ProjectStatusDto {
  id: StatusId;
  projectId: ProjectId;
  name: string;
  category: StatusCategory;
  position: number;
}

export interface DevProjectSettingsDto {
  namespaceId: NamespaceId;
  projectId: ProjectId;
  prefix: string;
  branchPrefix: string;
  startStatusId: StatusId | null;
  oldPrefixes: string[];
  enabledAt: string;
  updatedAt: string;
}

export interface ProjectDto {
  id: ProjectId;
  workspaceId: WorkspaceId;
  kind: ProjectKind;
  visibility: ProjectVisibility;
  name: string;
  description: string;
  statuses: ProjectStatusDto[];
  devSettings: DevProjectSettingsDto | null;
  myRole?: ProjectRole;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSettingsDto {
  workspaceId: WorkspaceId;
  defaultLocale: LocaleCode;
  devProjectsEnabled: boolean;
  updatedAt: string;
}

export interface WorkspaceSettingsResponse {
  contractVersion: typeof CONTRACT_VERSION;
  settings: WorkspaceSettingsDto;
}

export interface UpdateWorkspaceSettingsRequest {
  devProjectsEnabled?: boolean;
  defaultLocale?: LocaleCode;
}

export interface ProjectDevSettingsResponse {
  contractVersion: typeof CONTRACT_VERSION;
  allowed: boolean;
  canManage?: boolean;
  dev: DevProjectSettingsDto | null;
  statuses: ProjectStatusDto[];
}

export interface EnableDevProjectRequest {
  prefix: string;
  startStatusId?: StatusId | null;
}

export interface EnableDevProjectResponse {
  contractVersion: typeof CONTRACT_VERSION;
  allowed: boolean;
  dev: DevProjectSettingsDto;
  keyedCount: number;
}

export interface UpdateDevProjectSettingsRequest {
  prefix?: string;
  startStatusId?: StatusId | null;
}

export interface ProjectResponse {
  contractVersion: typeof CONTRACT_VERSION;
  project: ProjectDto;
}

export interface ProjectListResponse {
  contractVersion: typeof CONTRACT_VERSION;
  projects: ProjectDto[];
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  kind?: ProjectKind;
  visibility?: ProjectVisibility;
}

export interface TaskDto {
  id: TaskPublicId;
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  effectiveProjectId: ProjectId;
  parentTaskId: TaskPublicId | null;
  statusId: StatusId | null;
  issueKey: string | null;
  branchName: string | null;
  title: string;
  description: string;
  assigneeId: UserId | null;
  assigneeDisplayName?: string | null;
  createdBy: UserId | null;
  dueOn: string | null;
  completedAt: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface CopyTaskRequest {
  title?: string;
  projectId?: ProjectId;
  parentTaskId?: TaskPublicId | null;
  inheritParentProject?: boolean;
}

export interface DeleteTaskResponse {
  contractVersion: typeof CONTRACT_VERSION;
  deletedTaskId: TaskPublicId;
}

export interface MoveTaskRequest {
  projectId: ProjectId;
  statusId?: StatusId | null;
}

export type TaskSearchMatchKind = "exact_id" | "exact_key" | "text";

export interface TaskSearchItemDto {
  task: TaskDto;
  matchKind: TaskSearchMatchKind;
}

export interface TaskSearchResponse {
  contractVersion: typeof CONTRACT_VERSION;
  query: string;
  items: TaskSearchItemDto[];
}

export interface TaskResponse {
  contractVersion: typeof CONTRACT_VERSION;
  task: TaskDto;
  idempotentReplay?: boolean;
}

export interface TaskListResponse {
  contractVersion: typeof CONTRACT_VERSION;
  tasks: TaskDto[];
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  parentTaskId?: TaskPublicId | null;
  parentTaskRef?: string | null;
  inheritParentProject?: boolean;
  statusId?: StatusId | null;
  assigneeId?: UserId | null;
  dueOn?: string | null;
  idempotencyKey?: string;
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  projectId?: ProjectId;
  statusId?: StatusId | null;
  assigneeId?: UserId | null;
  dueOn?: string | null;
  completedAt?: string | null;
}

export interface StartTaskRequest {
  reopen?: boolean;
}

export interface StartTaskResponse {
  contractVersion: typeof CONTRACT_VERSION;
  task: TaskDto;
  branchName: string | null;
  changed: boolean;
}

export interface UpdateProjectStatusRequest {
  name?: string;
  position?: number;
}

export interface ProjectStatusResponse {
  contractVersion: typeof CONTRACT_VERSION;
  status: ProjectStatusDto;
}

export interface DeleteProjectStatusRequest {
  replacementStatusId?: StatusId | null;
}

export interface DeleteProjectStatusResponse {
  contractVersion: typeof CONTRACT_VERSION;
  deletedStatusId: StatusId;
  fallbackStatusId: StatusId | null;
  startStatusId: StatusId | null;
}

export interface OutboxEventDto {
  id: OutboxId;
  eventId: EventId;
  schemaVersion: number;
  workspaceId: WorkspaceId | null;
  projectId: ProjectId | null;
  eventType: string;
  action: string;
  outcome: EventOutcome;
  actorUserId: UserId | null;
  actorType: ActorType;
  channel: EventChannel;
  targetType: string;
  targetId: string | null;
  reasonCode: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  deliveryStatus: "pending" | "leased" | "delivered" | "failed";
}

export type RealtimeChangeKind =
  | "task.created"
  | "task.updated"
  | "task.started"
  | "task.moved"
  | "task.deleted"
  | "task.removed"
  | "project.created"
  | "project.dev_enabled"
  | "project.dev_settings.updated"
  | "project.status.updated"
  | "project.status.deleted"
  | "workspace.settings.updated";

export interface RealtimeReadyEventDto {
  contractVersion: typeof CONTRACT_VERSION;
  type: "ready";
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  cursor: string;
}

export interface RealtimeChangeEventDto {
  contractVersion: typeof CONTRACT_VERSION;
  type: "change";
  eventId: EventId;
  eventType: RealtimeChangeKind;
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  fromProjectId?: ProjectId | null;
  taskId?: TaskPublicId;
  task?: TaskDto;
  occurredAt: string;
  cursor: string;
}

export interface RealtimeResyncEventDto {
  contractVersion: typeof CONTRACT_VERSION;
  type: "resync";
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  reason: "cursor_expired" | "cursor_invalid";
  cursor: string;
}

export interface RealtimeRevokedEventDto {
  contractVersion: typeof CONTRACT_VERSION;
  type: "revoked";
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
}

export type RealtimeStreamEventDto =
  | RealtimeReadyEventDto
  | RealtimeChangeEventDto
  | RealtimeResyncEventDto
  | RealtimeRevokedEventDto;
