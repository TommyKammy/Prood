import type { WorkspaceMembershipSummary } from "@prood/contracts";
import type {
  ActorType,
  EventChannel,
  EventId,
  EventOutcome,
  LocaleCode,
  MembershipId,
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

export interface WorkspaceRecord {
  id: WorkspaceId;
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSettingsRecord {
  workspaceId: WorkspaceId;
  defaultLocale: LocaleCode;
  devProjectsEnabled: boolean;
  updatedAt: string;
}

export interface UserRecord {
  id: UserId;
  email: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthIdentityRecord {
  authProvider: string;
  authSubject: string;
  userId: UserId;
  createdAt: string;
}

export interface WorkspaceMembershipRecord {
  id: MembershipId;
  workspaceId: WorkspaceId;
  userId: UserId;
  role: WorkspaceRole;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: ProjectId;
  workspaceId: WorkspaceId;
  kind: ProjectKind;
  visibility: ProjectVisibility;
  name: string;
  description: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMembershipRecord {
  id: MembershipId;
  projectId: ProjectId;
  userId: UserId;
  role: ProjectRole;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectStatusRecord {
  id: StatusId;
  workspaceId: WorkspaceId;
  projectId: ProjectId;
  name: string;
  category: StatusCategory;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  version: number;
  id: TaskPublicId;
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  parentTaskId: TaskPublicId | null;
  statusId: StatusId | null;
  title: string;
  description: string;
  assigneeId: UserId | null;
  createdBy: UserId | null;
  dueOn: string | null;
  completedAt: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxEventRecord {
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
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string;
  deliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface CreateWorkspaceInput {
  id: WorkspaceId;
  slug: string;
  name: string;
  createdAt: string;
}

export interface UpsertWorkspaceSettingsInput {
  workspaceId: WorkspaceId;
  defaultLocale: LocaleCode;
  devProjectsEnabled: boolean;
  updatedAt: string;
}

export interface CreateUserInput {
  id: UserId;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface LinkAuthIdentityInput {
  authProvider: string;
  authSubject: string;
  userId: UserId;
  createdAt: string;
}

export interface CreateMembershipInput {
  id: MembershipId;
  workspaceId: WorkspaceId;
  userId: UserId;
  role: WorkspaceRole;
  createdAt: string;
}

export interface CreateProjectInput {
  id: ProjectId;
  workspaceId: WorkspaceId;
  kind: ProjectKind;
  visibility: ProjectVisibility;
  name: string;
  description: string;
  createdAt: string;
}

export interface UpsertProjectMembershipInput {
  id: MembershipId;
  projectId: ProjectId;
  userId: UserId;
  role: ProjectRole;
  createdAt: string;
}

export interface CreateProjectStatusInput {
  id: StatusId;
  workspaceId: WorkspaceId;
  projectId: ProjectId;
  name: string;
  category: StatusCategory;
  position: number;
  createdAt: string;
}

export interface CreateTaskInput {
  id: TaskPublicId;
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  parentTaskId: TaskPublicId | null;
  statusId: StatusId | null;
  title: string;
  description: string;
  assigneeId: UserId | null;
  createdBy: UserId | null;
  dueOn: string | null;
  position: number;
  createdAt: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  statusId?: StatusId | null;
  assigneeId?: UserId | null;
  dueOn?: string | null;
  completedAt?: string | null;
  updatedAt: string;
}

export interface AppendOutboxEventInput {
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
}

export interface WorkspaceRepository {
  create(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  findById(id: WorkspaceId): Promise<WorkspaceRecord | null>;
  findBySlug(slug: string): Promise<WorkspaceRecord | null>;
  updateName(
    id: WorkspaceId,
    name: string,
    updatedAt: string,
  ): Promise<WorkspaceRecord | null>;
}

export interface WorkspaceSettingsRepository {
  upsert(input: UpsertWorkspaceSettingsInput): Promise<WorkspaceSettingsRecord>;
  findByWorkspaceId(workspaceId: WorkspaceId): Promise<WorkspaceSettingsRecord | null>;
}

export interface UserRepository {
  findById(id: UserId): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findByAuthIdentity(
    authProvider: string,
    authSubject: string,
  ): Promise<UserRecord | null>;
  create(input: CreateUserInput): Promise<UserRecord>;
  linkAuthIdentity(input: LinkAuthIdentityInput): Promise<AuthIdentityRecord>;
}

export interface WorkspaceMembershipRepository {
  create(input: CreateMembershipInput): Promise<WorkspaceMembershipRecord>;
  findByWorkspaceAndUser(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<WorkspaceMembershipRecord | null>;
  listSummariesForUser(userId: UserId): Promise<WorkspaceMembershipSummary[]>;
}

export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<ProjectRecord>;
  findById(id: ProjectId): Promise<ProjectRecord | null>;
  listByWorkspace(workspaceId: WorkspaceId): Promise<ProjectRecord[]>;
  upsertMembership(
    input: UpsertProjectMembershipInput,
  ): Promise<ProjectMembershipRecord>;
  findMembership(
    projectId: ProjectId,
    userId: UserId,
  ): Promise<ProjectMembershipRecord | null>;
}

export interface ProjectStatusRepository {
  create(input: CreateProjectStatusInput): Promise<ProjectStatusRecord>;
  findById(id: StatusId): Promise<ProjectStatusRecord | null>;
  listByProject(projectId: ProjectId): Promise<ProjectStatusRecord[]>;
}

export interface TaskRepository {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  findById(id: TaskPublicId, forUpdate?: boolean): Promise<TaskRecord | null>;
  listByProject(projectId: ProjectId): Promise<TaskRecord[]>;
  listSubtasks(parentTaskId: TaskPublicId): Promise<TaskRecord[]>;
  listSubtasksByParentIds(
    parentTaskIds: readonly TaskPublicId[],
  ): Promise<TaskRecord[]>;
  update(id: TaskPublicId, input: UpdateTaskInput): Promise<TaskRecord | null>;
}

export interface OutboxRepository {
  append(input: AppendOutboxEventInput): Promise<OutboxEventRecord>;
  listByWorkspace(workspaceId: WorkspaceId): Promise<OutboxEventRecord[]>;
  listAll(): Promise<OutboxEventRecord[]>;
}

export interface TransactionRepositories {
  readonly automation: import("./automation.js").AutomationRepository;
  readonly workspaces: WorkspaceRepository;
  readonly workspaceSettings: WorkspaceSettingsRepository;
  readonly users: UserRepository;
  readonly memberships: WorkspaceMembershipRepository;
  readonly projects: ProjectRepository;
  readonly statuses: ProjectStatusRepository;
  readonly tasks: TaskRepository;
  readonly outbox: OutboxRepository;
}

/**
 * Executes a callback inside a single atomic DB transaction bound to the
 * passed repositories. Implementations handle driver-specific locking and
 * bounded transient conflict retries.
 */
export interface UnitOfWork {
  run<T>(fn: (repos: TransactionRepositories) => Promise<T>): Promise<T>;
}
