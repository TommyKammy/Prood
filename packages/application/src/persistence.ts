import type { DbDriverKind, WorkspaceMembershipSummary } from "@prood/contracts";
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

export interface IssueKeyNamespaceRecord {
  id: NamespaceId;
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  currentPrefix: string;
  branchPrefix: string;
  startStatusId: StatusId | null;
  enabledBy: UserId | null;
  enabledAt: string;
  updatedAt: string;
}

export interface IssueKeyPrefixRecord {
  workspaceId: WorkspaceId;
  prefix: string;
  namespaceId: NamespaceId;
  createdAt: string;
}

export interface TaskIssueKeyView {
  taskId: TaskPublicId;
  namespaceId: NamespaceId;
  issueNumber: number;
  currentPrefix: string;
  branchPrefix: string;
  createdAt: string;
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

export interface IdempotencyRecord {
  actorUserId: UserId;
  operation: string;
  idempotencyKey: string;
  requestFingerprint: string;
  workspaceId: WorkspaceId | null;
  projectId: ProjectId | null;
  targetType: string;
  targetId: string;
  responseJson: string;
  createdAt: string;
}

export interface CreateIdempotencyRecordInput {
  actorUserId: UserId;
  operation: string;
  idempotencyKey: string;
  requestFingerprint: string;
  workspaceId: WorkspaceId | null;
  projectId: ProjectId | null;
  targetType: string;
  targetId: string;
  responseJson: string;
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

export interface PatchWorkspaceSettingsInput {
  workspaceId: WorkspaceId;
  defaultLocale?: LocaleCode;
  devProjectsEnabled?: boolean;
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
  projectId?: ProjectId | null;
  parentTaskId?: TaskPublicId | null;
  statusId?: StatusId | null;
  assigneeId?: UserId | null;
  dueOn?: string | null;
  completedAt?: string | null;
  updatedAt: string;
}

export interface UpdateProjectStatusInput {
  name?: string;
  position?: number;
  updatedAt: string;
}

export interface CreateIssueKeyNamespaceInput {
  id: NamespaceId;
  workspaceId: WorkspaceId;
  projectId: ProjectId;
  currentPrefix: string;
  branchPrefix: string;
  startStatusId: StatusId | null;
  enabledBy: UserId | null;
  enabledAt: string;
}

export interface UpdateIssueKeyNamespaceInput {
  currentPrefix?: string;
  startStatusId?: StatusId | null;
  updatedAt: string;
}

export interface CreateTaskIssueKeyInput {
  taskId: TaskPublicId;
  namespaceId: NamespaceId;
  issueNumber: number;
  createdAt: string;
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
  patch(input: PatchWorkspaceSettingsInput): Promise<WorkspaceSettingsRecord>;
  findByWorkspaceId(workspaceId: WorkspaceId): Promise<WorkspaceSettingsRecord | null>;
}

export interface UserRepository {
  findById(id: UserId): Promise<UserRecord | null>;
  findByIds(ids: readonly UserId[]): Promise<Map<UserId, UserRecord>>;
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
  deleteByWorkspaceAndUser(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<boolean>;
  listSummariesForUser(userId: UserId): Promise<WorkspaceMembershipSummary[]>;
}

export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<ProjectRecord>;
  findById(id: ProjectId): Promise<ProjectRecord | null>;
  findByIdForUpdate(id: ProjectId): Promise<ProjectRecord | null>;
  lockForTaskWrite(id: ProjectId): Promise<boolean>;
  updateKind(
    id: ProjectId,
    kind: ProjectKind,
    updatedAt: string,
  ): Promise<ProjectRecord | null>;
  listByWorkspace(workspaceId: WorkspaceId): Promise<ProjectRecord[]>;
  upsertMembership(
    input: UpsertProjectMembershipInput,
  ): Promise<ProjectMembershipRecord>;
  findMembership(
    projectId: ProjectId,
    userId: UserId,
  ): Promise<ProjectMembershipRecord | null>;
  deleteMembership(projectId: ProjectId, userId: UserId): Promise<boolean>;
}

export interface ProjectStatusRepository {
  create(input: CreateProjectStatusInput): Promise<ProjectStatusRecord>;
  findById(id: StatusId): Promise<ProjectStatusRecord | null>;
  listByProject(projectId: ProjectId): Promise<ProjectStatusRecord[]>;
  update(
    id: StatusId,
    input: UpdateProjectStatusInput,
  ): Promise<ProjectStatusRecord | null>;
  deleteById(id: StatusId): Promise<boolean>;
}

export interface TaskRepository {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  findById(id: TaskPublicId, forUpdate?: boolean): Promise<TaskRecord | null>;
  lockByIdsForUpdate(ids: readonly TaskPublicId[]): Promise<TaskRecord[]>;
  listByProject(projectId: ProjectId): Promise<TaskRecord[]>;
  listSubtasks(parentTaskId: TaskPublicId): Promise<TaskRecord[]>;
  listSubtasksByParentIds(
    parentTaskIds: readonly TaskPublicId[],
  ): Promise<TaskRecord[]>;
  searchInWorkspace(input: {
    workspaceId: WorkspaceId;
    allowedProjectIds: readonly ProjectId[];
    query: string;
    limit: number;
    before?: { updatedAt: string; id: TaskPublicId };
  }): Promise<TaskRecord[]>;
  update(id: TaskPublicId, input: UpdateTaskInput): Promise<TaskRecord | null>;
  clearParentTaskIds(
    taskIds: readonly TaskPublicId[],
    updatedAt: string,
  ): Promise<void>;
  updateStatusForTaskIds(
    taskIds: readonly TaskPublicId[],
    statusId: StatusId | null,
    updatedAt: string,
  ): Promise<void>;
  replaceStatusInProject(
    projectId: ProjectId,
    fromStatusId: StatusId,
    toStatusId: StatusId | null,
    updatedAt: string,
  ): Promise<void>;
  deleteById(id: TaskPublicId): Promise<boolean>;
}

export interface IssueKeyRepository {
  createNamespace(
    input: CreateIssueKeyNamespaceInput,
  ): Promise<IssueKeyNamespaceRecord>;
  findNamespaceByProjectId(
    projectId: ProjectId,
  ): Promise<IssueKeyNamespaceRecord | null>;
  findNamespaceByProjectIdForUpdate(
    projectId: ProjectId,
  ): Promise<IssueKeyNamespaceRecord | null>;
  findNamespacesByProjectIds(
    projectIds: readonly ProjectId[],
  ): Promise<IssueKeyNamespaceRecord[]>;
  updateNamespace(
    id: NamespaceId,
    input: UpdateIssueKeyNamespaceInput,
  ): Promise<IssueKeyNamespaceRecord | null>;
  listPrefixesByNamespace(
    namespaceId: NamespaceId,
  ): Promise<IssueKeyPrefixRecord[]>;
  listPrefixesByNamespaceIds(
    namespaceIds: readonly NamespaceId[],
  ): Promise<IssueKeyPrefixRecord[]>;
  findPrefixOwner(
    workspaceId: WorkspaceId,
    prefix: string,
  ): Promise<IssueKeyPrefixRecord | null>;
  findProjectIdByWorkspacePrefix(
    workspaceId: WorkspaceId,
    prefix: string,
  ): Promise<ProjectId | null>;
  findProjectIdsByWorkspacesAndPrefix(
    workspaceIds: readonly WorkspaceId[],
    prefix: string,
  ): Promise<Array<{ workspaceId: WorkspaceId; projectId: ProjectId }>>;
  findTaskIdByWorkspaceKey(
    workspaceId: WorkspaceId,
    prefix: string,
    issueNumber: number,
  ): Promise<TaskPublicId | null>;
  findTaskIdsByWorkspacesAndKey(
    workspaceIds: readonly WorkspaceId[],
    prefix: string,
    issueNumber: number,
  ): Promise<Array<{ workspaceId: WorkspaceId; taskId: TaskPublicId }>>;
  reservePrefix(
    input: IssueKeyPrefixRecord,
  ): Promise<IssueKeyPrefixRecord | null>;
  initCounter(namespaceId: NamespaceId, nextNumber: number): Promise<void>;
  allocateNextNumber(namespaceId: NamespaceId): Promise<number>;
  createTaskKeys(entries: readonly CreateTaskIssueKeyInput[]): Promise<void>;
  findByTaskId(taskId: TaskPublicId): Promise<TaskIssueKeyView | null>;
  findByTaskIds(
    taskIds: readonly TaskPublicId[],
  ): Promise<Map<TaskPublicId, TaskIssueKeyView>>;
}

export interface OutboxRepository {
  append(input: AppendOutboxEventInput): Promise<OutboxEventRecord>;
  listByWorkspace(workspaceId: WorkspaceId): Promise<OutboxEventRecord[]>;
  listAll(): Promise<OutboxEventRecord[]>;
}

export interface IdempotencyRepository {
  findByKey(
    actorUserId: UserId,
    operation: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | null>;
  createIfAbsent(
    input: CreateIdempotencyRecordInput,
  ): Promise<IdempotencyRecord | null>;
}

export interface RealtimeEventRecord {
  seq: number;
  txid: string;
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  eventId: EventId;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

export interface AppendRealtimeEventInput {
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  eventId: EventId;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

export interface RealtimeRetentionState {
  prunedThroughTxid: string;
  prunedThroughSeq: number;
}

export interface RealtimeSnapshotState {
  driver: DbDriverKind;
  xmin: string;
  xmax: string;
  maxSeq: number;
  activeXips: string[];
  retention: RealtimeRetentionState;
}

export interface RealtimeEventsRepository {
  append(input: AppendRealtimeEventInput): Promise<RealtimeEventRecord>;
  readSnapshotState(workspaceId: WorkspaceId): Promise<RealtimeSnapshotState>;
  listAfterPosition(input: {
    workspaceId: WorkspaceId;
    watermarkTxid: string;
    watermarkSeq: number;
    pendingTxids: ReadonlyArray<{ txid: string; afterSeq: number }>;
    limit: number;
  }): Promise<{
    snapshot: RealtimeSnapshotState;
    events: RealtimeEventRecord[];
  }>;
  prune(input: {
    beforeCreatedAt?: string;
    keepLast?: number;
    nowIso: string;
  }): Promise<{
    deletedCount: number;
    prunedThroughTxid: string;
    prunedThroughSeq: number;
  }>;
}

export interface TransactionRepositories {
  readonly automation: import("./automation.js").AutomationRepository;
  readonly driver?: DbDriverKind;
  readonly workspaces: WorkspaceRepository;
  readonly workspaceSettings: WorkspaceSettingsRepository;
  readonly users: UserRepository;
  readonly memberships: WorkspaceMembershipRepository;
  readonly projects: ProjectRepository;
  readonly statuses: ProjectStatusRepository;
  readonly tasks: TaskRepository;
  readonly issueKeys: IssueKeyRepository;
  readonly outbox: OutboxRepository;
  readonly idempotency: IdempotencyRepository;
  readonly realtimeEvents: RealtimeEventsRepository;
}

/**
 * Executes a callback inside a single atomic DB transaction bound to the
 * passed repositories. Implementations handle driver-specific locking and
 * bounded transient conflict retries.
 */
export interface UnitOfWork {
  run<T>(fn: (repos: TransactionRepositories) => Promise<T>): Promise<T>;
}
