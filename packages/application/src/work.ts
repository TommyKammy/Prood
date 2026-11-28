import {
  CONTRACT_VERSION,
  type ApiErrorCode,
  type CopyTaskRequest,
  type CreateProjectRequest,
  type CreateTaskRequest,
  type DeleteTaskResponse,
  type DevProjectSettingsDto,
  type EnableDevProjectRequest,
  type EnableDevProjectResponse,
  type MoveTaskRequest,
  type OutboxEventDto,
  type ProjectDevSettingsResponse,
  type ProjectDto,
  type ProjectListResponse,
  type ProjectResponse,
  type ProjectStatusDto,
  type TaskDto,
  type TaskListResponse,
  type TaskResponse,
  type TaskSearchItemDto,
  type TaskSearchMatchKind,
  type TaskSearchResponse,
  type UpdateDevProjectSettingsRequest,
  type UpdateTaskRequest,
  type UpdateWorkspaceSettingsRequest,
  type WorkspaceSettingsDto,
  type WorkspaceSettingsResponse,
} from "@prood/contracts";
import {
  canManageProject,
  canReadProject,
  canWriteProjectTasks,
  DEFAULT_LOCALE,
  DEV_PROJECT_ENABLE_MAX_TASKS,
  formatBranchName,
  formatIssueKey,
  isValidEntityId,
  isValidProjectKind,
  isValidProjectVisibility,
  normalizeDevPrefix,
  OUTBOX_SCHEMA_VERSION,
  parseIssueKey,
  resolveEffectiveProjectRole,
  type AuditActorContext,
  type EventChannel,
  type LocaleCode,
  type ProjectId,
  type ProjectRole,
  type StatusCategory,
  type StatusId,
  type TaskPublicId,
  type UserId,
  type WorkspaceId,
} from "@prood/domain";
import type { IdGenerator } from "./id.js";
import type { Clock } from "./index.js";
import type {
  IssueKeyNamespaceRecord,
  IssueKeyPrefixRecord,
  OutboxEventRecord,
  ProjectRecord,
  ProjectStatusRecord,
  TaskIssueKeyView,
  TaskRecord,
  TransactionRepositories,
  UnitOfWork,
  WorkspaceSettingsRecord,
} from "./persistence.js";

export type WorkUseCaseResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 409;
      code: ApiErrorCode;
      messageKey: string;
    };

export interface WorkUseCaseDeps {
  uow: UnitOfWork;
  idGenerator: IdGenerator;
  clock: Clock;
}

const MAX_PARENT_HOPS = 16;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail<T>(
  status: 400 | 401 | 403 | 404 | 409,
  code: ApiErrorCode,
  messageKey: string,
): WorkUseCaseResult<T> {
  return { ok: false, status, code, messageKey };
}

class RollbackWorkResultError<T> extends Error {
  constructor(readonly result: WorkUseCaseResult<T>) {
    super("Rollback work use case transaction");
  }
}

async function runWorkTx<T>(
  uow: UnitOfWork,
  fn: (repos: TransactionRepositories) => Promise<WorkUseCaseResult<T>>,
): Promise<WorkUseCaseResult<T>> {
  try {
    return await uow.run(fn);
  } catch (error) {
    if (error instanceof RollbackWorkResultError) {
      return error.result as WorkUseCaseResult<T>;
    }
    throw error;
  }
}

function toStatusDto(record: ProjectStatusRecord): ProjectStatusDto {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    category: record.category,
    position: record.position,
  };
}

function toDevProjectSettingsDto(
  namespace: IssueKeyNamespaceRecord,
  prefixes: readonly IssueKeyPrefixRecord[],
): DevProjectSettingsDto {
  return {
    namespaceId: namespace.id,
    projectId: namespace.projectId!,
    prefix: namespace.currentPrefix,
    branchPrefix: namespace.branchPrefix,
    startStatusId: namespace.startStatusId,
    oldPrefixes: prefixes
      .filter((entry) => entry.prefix !== namespace.currentPrefix)
      .map((entry) => entry.prefix),
    enabledAt: namespace.enabledAt,
    updatedAt: namespace.updatedAt,
  };
}

function toWorkspaceSettingsDto(
  workspaceId: WorkspaceId,
  record: WorkspaceSettingsRecord | null,
  fallbackUpdatedAt: string,
): WorkspaceSettingsDto {
  return {
    workspaceId,
    defaultLocale: record?.defaultLocale ?? DEFAULT_LOCALE,
    devProjectsEnabled: record?.devProjectsEnabled ?? false,
    updatedAt: record?.updatedAt ?? fallbackUpdatedAt,
  };
}

function toProjectDto(
  project: ProjectRecord,
  statuses: ProjectStatusRecord[],
  devSettings: DevProjectSettingsDto | null = null,
  myRole?: ProjectRole,
): ProjectDto {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    kind: project.kind,
    visibility: project.visibility,
    name: project.name,
    description: project.description,
    statuses: statuses.map(toStatusDto),
    devSettings,
    ...(myRole ? { myRole } : {}),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function toTaskDto(
  task: TaskRecord,
  effectiveProjectId: ProjectId,
  issueKeyView: TaskIssueKeyView | null = null,
  showIssueKey = true,
): TaskDto {
  const visibleKey = showIssueKey ? issueKeyView : null;
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    effectiveProjectId,
    parentTaskId: task.parentTaskId,
    statusId: task.statusId,
    issueKey: visibleKey
      ? formatIssueKey(visibleKey.currentPrefix, visibleKey.issueNumber)
      : null,
    branchName: visibleKey
      ? formatBranchName(visibleKey.branchPrefix, visibleKey.issueNumber)
      : null,
    title: task.title,
    description: task.description,
    assigneeId: task.assigneeId,
    createdBy: task.createdBy,
    dueOn: task.dueOn,
    completedAt: task.completedAt,
    position: task.position,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function toOutboxEventDto(record: OutboxEventRecord): OutboxEventDto {
  return {
    id: record.id,
    eventId: record.eventId,
    schemaVersion: record.schemaVersion,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    eventType: record.eventType,
    action: record.action,
    outcome: record.outcome,
    actorUserId: record.actorUserId,
    actorType: record.actorType,
    channel: record.channel,
    targetType: record.targetType,
    targetId: record.targetId,
    reasonCode: record.reasonCode,
    payload: record.payload,
    occurredAt: record.occurredAt,
    deliveryStatus: record.deliveryStatus,
  };
}

/**
 * Work-item CRUD, effective permission resolution (including inherited subtask visibility),
 * and versioned transactional outbox recording (including entry-level denials & auth failures).
 */
export function createWorkUseCases(deps: WorkUseCaseDeps) {
  async function appendOutbox(
    repos: TransactionRepositories,
    params: {
      workspaceId: WorkspaceId | null;
      projectId: ProjectId | null;
      eventType: string;
      action: string;
      outcome: "succeeded" | "denied";
      actor: AuditActorContext;
      targetType: string;
      targetId: string | null;
      reasonCode: string | null;
      payload: Record<string, unknown>;
    },
  ): Promise<OutboxEventRecord> {
    const nowIso = deps.clock.now().toISOString();
    return repos.outbox.append({
      id: deps.idGenerator.next("out"),
      eventId: deps.idGenerator.next("evt"),
      schemaVersion: OUTBOX_SCHEMA_VERSION,
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      eventType: params.eventType,
      action: params.action,
      outcome: params.outcome,
      actorUserId: params.actor.userId,
      actorType: params.actor.actorType,
      channel: params.actor.channel,
      targetType: params.targetType,
      targetId: params.targetId,
      reasonCode: params.reasonCode,
      payload: {
        schemaVersion: OUTBOX_SCHEMA_VERSION,
        ...(params.actor.clientId ? { clientId: params.actor.clientId } : {}),
        ...params.payload,
      },
      occurredAt: nowIso,
    });
  }

  async function resolveActorProjectRole(
    repos: TransactionRepositories,
    userId: UserId | null,
    project: ProjectRecord,
  ): Promise<ProjectRole | null> {
    if (!userId) {
      return null;
    }
    const workspaceMembership = await repos.memberships.findByWorkspaceAndUser(
      project.workspaceId,
      userId,
    );
    if (!workspaceMembership) {
      return null;
    }
    const projectMembership = await repos.projects.findMembership(
      project.id,
      userId,
    );
    return resolveEffectiveProjectRole({
      workspaceRole: workspaceMembership.role,
      projectVisibility: project.visibility,
      projectMembershipRole: projectMembership?.role ?? null,
    });
  }

  async function resolveTaskEffectiveProject(
    repos: TransactionRepositories,
    task: TaskRecord,
  ): Promise<{ project: ProjectRecord; depth: number } | null> {
    let current: TaskRecord | null = task;
    const visited = new Set<string>();
    for (let hop = 0; hop < MAX_PARENT_HOPS && current; hop += 1) {
      if (current.projectId) {
        const project = await repos.projects.findById(current.projectId);
        if (!project || project.workspaceId !== task.workspaceId) {
          return null;
        }
        return { project, depth: hop };
      }
      if (!current.parentTaskId || visited.has(current.parentTaskId)) {
        return null;
      }
      visited.add(current.id);
      const parent = await repos.tasks.findById(current.parentTaskId);
      if (!parent || parent.workspaceId !== task.workspaceId) {
        return null;
      }
      current = parent;
    }
    return null;
  }

  /**
   * Lock a task and its inherited-project ancestor chain FOR UPDATE (on PostgreSQL)
   * and re-verify the chain under those locks so concurrent project moves serialize
   * cleanly with authorization and mutation.
   */
  async function lockTaskChainInTx(
    repos: TransactionRepositories,
    taskId: TaskPublicId,
  ): Promise<{ task: TaskRecord; project: ProjectRecord; depth: number } | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const discoveredIds: TaskPublicId[] = [];
      const discoverSeen = new Set<TaskPublicId>();
      let cursorId: TaskPublicId | null = taskId;

      for (let hop = 0; hop < MAX_PARENT_HOPS && cursorId; hop += 1) {
        if (discoverSeen.has(cursorId)) {
          return null;
        }
        discoverSeen.add(cursorId);
        discoveredIds.push(cursorId);
        const row = await repos.tasks.findById(cursorId);
        if (!row) {
          return null;
        }
        if (row.projectId !== null) {
          break;
        }
        cursorId = row.parentTaskId;
      }

      const lockedRows = await repos.tasks.lockByIdsForUpdate(discoveredIds);
      const lockedById = new Map<TaskPublicId, TaskRecord>(
        lockedRows.map((row) => [row.id, row]),
      );
      const lockedTask = lockedById.get(taskId);
      if (!lockedTask) {
        return null;
      }

      let current: TaskRecord = lockedTask;
      const walkSeen = new Set<TaskPublicId>();
      let depth = 0;
      let stable = true;

      for (let hop = 0; hop < MAX_PARENT_HOPS; hop += 1) {
        if (current.projectId) {
          depth = hop;
          break;
        }
        if (!current.parentTaskId || walkSeen.has(current.parentTaskId)) {
          return null;
        }
        walkSeen.add(current.id);
        const lockedParent = lockedById.get(current.parentTaskId);
        if (!lockedParent) {
          stable = false;
          break;
        }
        if (lockedParent.workspaceId !== lockedTask.workspaceId) {
          return null;
        }
        current = lockedParent;
        if (hop + 1 >= MAX_PARENT_HOPS) {
          return null;
        }
      }

      if (!stable) {
        continue;
      }
      if (!current.projectId) {
        return null;
      }
      const project = await repos.projects.findById(current.projectId);
      if (!project || project.workspaceId !== lockedTask.workspaceId) {
        return null;
      }
      return { task: lockedTask, project, depth };
    }
    return null;
  }

  async function collectDescendantsInTx(
    repos: TransactionRepositories,
    initialFrontier: readonly TaskPublicId[],
    includeChild: (child: TaskRecord) => boolean,
  ): Promise<TaskRecord[]> {
    const collected = new Map<TaskPublicId, TaskRecord>();
    let frontier = Array.from(initialFrontier);
    for (
      let depth = 0;
      depth < MAX_PARENT_HOPS && frontier.length > 0;
      depth += 1
    ) {
      const children = await repos.tasks.listSubtasksByParentIds(frontier);
      const nextFrontier: TaskPublicId[] = [];
      for (const child of children) {
        if (!collected.has(child.id) && includeChild(child)) {
          collected.set(child.id, child);
          nextFrontier.push(child.id);
        }
      }
      frontier = nextFrontier;
    }
    return Array.from(collected.values());
  }

  async function collectProjectTasksInTx(
    repos: TransactionRepositories,
    projectId: ProjectId,
  ): Promise<TaskRecord[]> {
    const directTasks = await repos.tasks.listByProject(projectId);
    const descendants = await collectDescendantsInTx(
      repos,
      directTasks.map((t) => t.id),
      (child) => child.projectId === null || child.projectId === projectId,
    );
    const seen = new Set(directTasks.map((t) => t.id));
    return [
      ...directTasks,
      ...descendants.filter((child) => !seen.has(child.id)),
    ];
  }

  interface ResolvedTaskContext {
    task: TaskRecord;
    effectiveProject: ProjectRecord;
    role: ProjectRole | null;
  }

  async function resolveProjectRefInTx(
    repos: TransactionRepositories,
    workspaceId: WorkspaceId,
    projectRef: string,
  ): Promise<ProjectRecord | null> {
    const trimmed = projectRef.trim();
    if (!trimmed) {
      return null;
    }
    if (isValidEntityId("prj", trimmed)) {
      const project = await repos.projects.findById(trimmed);
      if (!project || project.workspaceId !== workspaceId) {
        return null;
      }
      return project;
    }
    const normalizedPrefix = normalizeDevPrefix(trimmed);
    if (!normalizedPrefix) {
      return null;
    }
    const resolvedId = await repos.issueKeys.findProjectIdByWorkspacePrefix(
      workspaceId,
      normalizedPrefix,
    );
    if (!resolvedId) {
      return null;
    }
    const project = await repos.projects.findById(resolvedId);
    if (!project || project.workspaceId !== workspaceId) {
      return null;
    }
    return project;
  }

  async function loadTaskContextInTx(
    repos: TransactionRepositories,
    actor: AuditActorContext,
    taskId: TaskPublicId,
    workspaceFilter?: WorkspaceId,
    options?: { lockForWrite?: boolean },
  ): Promise<ResolvedTaskContext | null> {
    if (options?.lockForWrite) {
      const locked = await lockTaskChainInTx(repos, taskId);
      if (!locked) {
        return null;
      }
      if (workspaceFilter && locked.task.workspaceId !== workspaceFilter) {
        return null;
      }
      const role = await resolveActorProjectRole(
        repos,
        actor.userId,
        locked.project,
      );
      return {
        task: locked.task,
        effectiveProject: locked.project,
        role,
      };
    }

    const task = await repos.tasks.findById(taskId);
    if (!task) {
      return null;
    }
    if (workspaceFilter && task.workspaceId !== workspaceFilter) {
      return null;
    }
    const resolved = await resolveTaskEffectiveProject(repos, task);
    if (!resolved) {
      return null;
    }
    const role = await resolveActorProjectRole(
      repos,
      actor.userId,
      resolved.project,
    );
    return { task, effectiveProject: resolved.project, role };
  }

  async function resolveTaskRefInTx<T>(
    repos: TransactionRepositories,
    actor: AuditActorContext,
    taskRef: string,
    options?: { workspaceId?: WorkspaceId; lockForWrite?: boolean },
  ): Promise<
    | { found: true; ctx: ResolvedTaskContext }
    | {
        found: false;
        failure: WorkUseCaseResult<T>;
        deniedTarget?: ResolvedTaskContext;
      }
  > {
    const trimmed = typeof taskRef === "string" ? taskRef.trim() : "";
    if (!trimmed) {
      return { found: false, failure: fail(404, "NOT_FOUND", "error.notFound") };
    }

    if (isValidEntityId("tsk", trimmed)) {
      const ctx = await loadTaskContextInTx(
        repos,
        actor,
        trimmed,
        options?.workspaceId,
        { lockForWrite: options?.lockForWrite },
      );
      if (!ctx) {
        return {
          found: false,
          failure: fail(404, "NOT_FOUND", "error.notFound"),
        };
      }
      return { found: true, ctx };
    }

    const parsedKey = parseIssueKey(trimmed);
    if (!parsedKey) {
      return { found: false, failure: fail(404, "NOT_FOUND", "error.notFound") };
    }

    if (options?.workspaceId) {
      const taskId = await repos.issueKeys.findTaskIdByWorkspaceKey(
        options.workspaceId,
        parsedKey.prefix,
        parsedKey.number,
      );
      if (!taskId) {
        return {
          found: false,
          failure: fail(404, "NOT_FOUND", "error.notFound"),
        };
      }
      const ctx = await loadTaskContextInTx(
        repos,
        actor,
        taskId,
        options.workspaceId,
        { lockForWrite: options.lockForWrite },
      );
      if (!ctx) {
        return {
          found: false,
          failure: fail(404, "NOT_FOUND", "error.notFound"),
        };
      }
      return { found: true, ctx };
    }

    const summaries = actor.userId
      ? await repos.memberships.listSummariesForUser(actor.userId)
      : [];
    if (summaries.length === 0) {
      return { found: false, failure: fail(404, "NOT_FOUND", "error.notFound") };
    }

    const candidates = await repos.issueKeys.findTaskIdsByWorkspacesAndKey(
      summaries.map((s) => s.workspaceId),
      parsedKey.prefix,
      parsedKey.number,
    );
    const readable: ResolvedTaskContext[] = [];
    const denied: ResolvedTaskContext[] = [];
    for (const candidate of candidates) {
      const ctx = await loadTaskContextInTx(
        repos,
        actor,
        candidate.taskId,
        candidate.workspaceId,
      );
      if (!ctx) {
        continue;
      }
      if (canReadProject(ctx.role)) {
        readable.push(ctx);
      } else {
        denied.push(ctx);
      }
    }

    if (readable.length === 1) {
      const chosen = readable[0]!;
      if (options?.lockForWrite) {
        const lockedCtx = await loadTaskContextInTx(
          repos,
          actor,
          chosen.task.id,
          chosen.task.workspaceId,
          { lockForWrite: true },
        );
        if (!lockedCtx) {
          return {
            found: false,
            failure: fail(404, "NOT_FOUND", "error.notFound"),
          };
        }
        if (!canReadProject(lockedCtx.role)) {
          return {
            found: false,
            failure: fail(404, "NOT_FOUND", "error.notFound"),
            deniedTarget: lockedCtx,
          };
        }
        return { found: true, ctx: lockedCtx };
      }
      return { found: true, ctx: chosen };
    }
    if (readable.length > 1) {
      return {
        found: false,
        failure: fail(409, "CONFLICT", "error.ambiguousIssueKey"),
      };
    }
    return {
      found: false,
      failure: fail(404, "NOT_FOUND", "error.notFound"),
      deniedTarget: denied[0],
    };
  }

  async function partitionMovingSubtreeInTx(
    repos: TransactionRepositories,
    rootTaskId: TaskPublicId,
    targetProjectId: ProjectId,
  ): Promise<{
    movingInheritedDescendants: TaskRecord[];
    detachChildIds: TaskPublicId[];
  }> {
    const moving = new Map<TaskPublicId, TaskRecord>();
    const detach = new Set<TaskPublicId>();
    let frontier: TaskPublicId[] = [rootTaskId];

    for (
      let depth = 0;
      depth < MAX_PARENT_HOPS && frontier.length > 0;
      depth += 1
    ) {
      const children = await repos.tasks.listSubtasksByParentIds(frontier);
      const nextFrontier: TaskPublicId[] = [];
      for (const child of children) {
        if (child.projectId === null) {
          if (!moving.has(child.id)) {
            moving.set(child.id, child);
            nextFrontier.push(child.id);
          }
        } else if (child.projectId !== targetProjectId) {
          // Child explicitly lives in another project (e.g. sourceProject);
          // detach it so parent deletion in targetProject cannot cascade across projects.
          detach.add(child.id);
        }
      }
      frontier = nextFrontier;
    }

    return {
      movingInheritedDescendants: Array.from(moving.values()),
      detachChildIds: Array.from(detach),
    };
  }

  async function remapMovingSubtreeStatusesInTx(
    repos: TransactionRepositories,
    movingDescendants: readonly TaskRecord[],
    sourceProjectId: ProjectId,
    targetProjectId: ProjectId,
    prefetchedTargetStatuses: readonly ProjectStatusRecord[] | undefined,
    nowIso: string,
  ): Promise<void> {
    if (movingDescendants.length === 0) {
      return;
    }
    const [sourceStatuses, targetStatuses] = await Promise.all([
      repos.statuses.listByProject(sourceProjectId),
      prefetchedTargetStatuses
        ? Promise.resolve(prefetchedTargetStatuses)
        : repos.statuses.listByProject(targetProjectId),
    ]);
    const sourceById = new Map<StatusId, ProjectStatusRecord>(
      sourceStatuses.map((s) => [s.id, s]),
    );
    const targetByCategory = new Map<StatusCategory, StatusId>();
    for (const st of targetStatuses) {
      if (!targetByCategory.has(st.category)) {
        targetByCategory.set(st.category, st.id);
      }
    }
    const defaultTargetStatusId = targetStatuses[0]?.id ?? null;

    const groupedByNextStatus = new Map<StatusId | null, TaskPublicId[]>();
    for (const desc of movingDescendants) {
      if (desc.statusId === null) {
        continue;
      }
      const sourceStatus = sourceById.get(desc.statusId);
      const nextStatusId =
        (sourceStatus
          ? targetByCategory.get(sourceStatus.category)
          : undefined) ?? defaultTargetStatusId;
      if (nextStatusId === desc.statusId) {
        continue;
      }
      const bucket = groupedByNextStatus.get(nextStatusId) ?? [];
      bucket.push(desc.id);
      groupedByNextStatus.set(nextStatusId, bucket);
    }

    for (const [nextStatusId, ids] of groupedByNextStatus) {
      await repos.tasks.updateStatusForTaskIds(ids, nextStatusId, nowIso);
    }
  }

  async function assignMissingKeysForSubtreeInTx(
    repos: TransactionRepositories,
    rootTask: TaskRecord,
    movingInheritedDescendants: readonly TaskRecord[],
    targetProject: ProjectRecord,
    nowIso: string,
  ): Promise<void> {
    await repos.projects.lockForTaskWrite(targetProject.id);
    const namespace = await repos.issueKeys.findNamespaceByProjectId(
      targetProject.id,
    );
    if (!namespace) {
      return;
    }

    const subtreeTasks = [rootTask, ...movingInheritedDescendants];
    const existingKeys = await repos.issueKeys.findByTaskIds(
      subtreeTasks.map((t) => t.id),
    );
    const unkeyed = subtreeTasks
      .filter((t) => !existingKeys.has(t.id))
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) {
          return a.createdAt < b.createdAt ? -1 : 1;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    if (unkeyed.length === 0) {
      return;
    }

    const entries: Array<{
      taskId: TaskPublicId;
      namespaceId: IssueKeyNamespaceRecord["id"];
      issueNumber: number;
      createdAt: string;
    }> = [];
    for (const item of unkeyed) {
      const issueNumber = await repos.issueKeys.allocateNextNumber(namespace.id);
      entries.push({
        taskId: item.id,
        namespaceId: namespace.id,
        issueNumber,
        createdAt: nowIso,
      });
    }
    await repos.issueKeys.createTaskKeys(entries);
  }

  async function insertTaskAndIssueKeyInTx(
    repos: TransactionRepositories,
    params: {
      actor: AuditActorContext;
      effectiveProject: ProjectRecord;
      storedProjectId: ProjectId | null;
      parentTaskId: TaskPublicId | null;
      statusId: StatusId | null;
      title: string;
      description: string;
      assigneeId: UserId | null;
      dueOn: string | null;
      creationKind: "create" | "subtask" | "copy";
      copiedFromTaskId?: TaskPublicId;
    },
  ): Promise<{ task: TaskRecord; issueKey: TaskIssueKeyView | null }> {
    // Serialize against concurrent enableDevProject() FOR UPDATE lock on the project row.
    await repos.projects.lockForTaskWrite(params.effectiveProject.id);
    const namespace = await repos.issueKeys.findNamespaceByProjectId(
      params.effectiveProject.id,
    );

    const nowIso = deps.clock.now().toISOString();
    const taskId = deps.idGenerator.next("tsk");
    const task = await repos.tasks.create({
      id: taskId,
      workspaceId: params.effectiveProject.workspaceId,
      projectId: params.storedProjectId,
      parentTaskId: params.parentTaskId,
      statusId: params.statusId,
      title: params.title,
      description: params.description,
      assigneeId: params.assigneeId,
      createdBy: params.actor.userId,
      dueOn: params.dueOn,
      position: 0,
      createdAt: nowIso,
    });

    let issueKeyView: TaskIssueKeyView | null = null;
    if (namespace) {
      const issueNumber = await repos.issueKeys.allocateNextNumber(namespace.id);
      await repos.issueKeys.createTaskKeys([
        {
          taskId: task.id,
          namespaceId: namespace.id,
          issueNumber,
          createdAt: nowIso,
        },
      ]);
      issueKeyView = {
        taskId: task.id,
        namespaceId: namespace.id,
        issueNumber,
        currentPrefix: namespace.currentPrefix,
        branchPrefix: namespace.branchPrefix,
        createdAt: nowIso,
      };
    }

    const formattedKey = issueKeyView
      ? formatIssueKey(issueKeyView.currentPrefix, issueKeyView.issueNumber)
      : null;

    await appendOutbox(repos, {
      workspaceId: params.effectiveProject.workspaceId,
      projectId: params.effectiveProject.id,
      eventType: "task.created",
      action: "task.create",
      outcome: "succeeded",
      actor: params.actor,
      targetType: "task",
      targetId: task.id,
      reasonCode: null,
      payload: {
        taskId: task.id,
        projectId: params.effectiveProject.id,
        projectKind: params.effectiveProject.kind,
        parentTaskId: task.parentTaskId,
        creationKind: params.creationKind,
        ...(params.copiedFromTaskId
          ? { copiedFromTaskId: params.copiedFromTaskId }
          : {}),
        issueKey: formattedKey,
        title: task.title,
        statusId: task.statusId,
        assigneeId: task.assigneeId,
      },
    });

    return { task, issueKey: issueKeyView };
  }

  return {
    async recordEntryAuthFailure(input: {
      channel: EventChannel;
      path: string;
      reasonCode: string;
      detail?: string;
    }): Promise<void> {
      await deps.uow.run(async (repos) => {
        await appendOutbox(repos, {
          workspaceId: null,
          projectId: null,
          eventType: "auth.failed",
          action: "auth.authenticate",
          outcome: "denied",
          actor: {
            userId: null,
            actorType: "anonymous",
            channel: input.channel,
          },
          targetType: "auth",
          targetId: input.path,
          reasonCode: input.reasonCode,
          payload: {
            path: input.path,
            reasonCode: input.reasonCode,
            ...(input.detail ? { detail: input.detail } : {}),
          },
        });
      });
    },

    async createProject(
      actor: AuditActorContext,
      workspaceId: WorkspaceId,
      input: CreateProjectRequest,
    ): Promise<WorkUseCaseResult<ProjectResponse>> {
      if (!isPlainObject(input)) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      const kind = input.kind ?? "general";
      if (typeof kind !== "string" || !isValidProjectKind(kind)) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      const visibility = input.visibility ?? "workspace";
      if (typeof visibility !== "string" || !isValidProjectVisibility(visibility)) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (input.description !== undefined && typeof input.description !== "string") {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      const description =
        typeof input.description === "string" ? input.description.trim() : "";

      return deps.uow.run(async (repos) => {
        const workspace = await repos.workspaces.findById(workspaceId);
        if (!workspace) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const wsMembership = actor.userId
          ? await repos.memberships.findByWorkspaceAndUser(workspaceId, actor.userId)
          : null;
        if (!wsMembership || wsMembership.role === "viewer") {
          await appendOutbox(repos, {
            workspaceId,
            projectId: null,
            eventType: "project.create.denied",
            action: "project.create",
            outcome: "denied",
            actor,
            targetType: "workspace",
            targetId: workspaceId,
            reasonCode: "FORBIDDEN",
            payload: { name, kind, visibility },
          });
          return fail(403, "FORBIDDEN", "error.forbidden");
        }

        const nowIso = deps.clock.now().toISOString();
        const project = await repos.projects.create({
          id: deps.idGenerator.next("prj"),
          workspaceId,
          kind,
          visibility,
          name,
          description,
          createdAt: nowIso,
        });

        await repos.projects.upsertMembership({
          id: deps.idGenerator.next("mbr"),
          projectId: project.id,
          userId: actor.userId!,
          role: "admin",
          createdAt: nowIso,
        });

        const defaultStatuses: ProjectStatusRecord[] = [];
        const seeds = [
          { name: "To Do", category: "todo" as const, position: 0 },
          { name: "In Progress", category: "in_progress" as const, position: 1 },
          { name: "Done", category: "done" as const, position: 2 },
        ];
        for (const seed of seeds) {
          defaultStatuses.push(
            await repos.statuses.create({
              id: deps.idGenerator.next("sts"),
              workspaceId,
              projectId: project.id,
              name: seed.name,
              category: seed.category,
              position: seed.position,
              createdAt: nowIso,
            }),
          );
        }

        await appendOutbox(repos, {
          workspaceId,
          projectId: project.id,
          eventType: "project.created",
          action: "project.create",
          outcome: "succeeded",
          actor,
          targetType: "project",
          targetId: project.id,
          reasonCode: null,
          payload: {
            projectId: project.id,
            kind: project.kind,
            visibility: project.visibility,
            name: project.name,
          },
        });

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            project: toProjectDto(project, defaultStatuses, null, "admin"),
          },
        };
      });
    },

    async listProjects(
      actor: AuditActorContext,
      workspaceId: WorkspaceId,
    ): Promise<WorkUseCaseResult<ProjectListResponse>> {
      return deps.uow.run(async (repos) => {
        const wsMembership = actor.userId
          ? await repos.memberships.findByWorkspaceAndUser(workspaceId, actor.userId)
          : null;
        if (!wsMembership) {
          await appendOutbox(repos, {
            workspaceId: null,
            projectId: null,
            eventType: "project.list.denied",
            action: "project.list",
            outcome: "denied",
            actor,
            targetType: "workspace",
            targetId: workspaceId,
            reasonCode: "FORBIDDEN",
            payload: { workspaceId },
          });
          return fail(403, "FORBIDDEN", "error.forbidden");
        }

        const allProjects = await repos.projects.listByWorkspace(workspaceId);
        const visibleProjects: Array<{ project: ProjectRecord; role: ProjectRole }> = [];
        for (const project of allProjects) {
          const role = await resolveActorProjectRole(repos, actor.userId, project);
          if (canReadProject(role) && role !== null) {
            visibleProjects.push({ project, role });
          }
        }

        const namespaces = await repos.issueKeys.findNamespacesByProjectIds(
          visibleProjects.map((entry) => entry.project.id),
        );
        const namespaceByProjectId = new Map<ProjectId, IssueKeyNamespaceRecord>();
        for (const ns of namespaces) {
          if (ns.projectId) {
            namespaceByProjectId.set(ns.projectId, ns);
          }
        }
        const prefixes = await repos.issueKeys.listPrefixesByNamespaceIds(
          namespaces.map((n) => n.id),
        );
        const prefixesByNamespaceId = new Map<string, IssueKeyPrefixRecord[]>();
        for (const entry of prefixes) {
          const list = prefixesByNamespaceId.get(entry.namespaceId) ?? [];
          list.push(entry);
          prefixesByNamespaceId.set(entry.namespaceId, list);
        }

        const visible: ProjectDto[] = [];
        for (const { project, role } of visibleProjects) {
          const statuses = await repos.statuses.listByProject(project.id);
          const ns = namespaceByProjectId.get(project.id) ?? null;
          const devSettings = ns
            ? toDevProjectSettingsDto(ns, prefixesByNamespaceId.get(ns.id) ?? [])
            : null;
          visible.push(toProjectDto(project, statuses, devSettings, role));
        }
        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            projects: visible,
          },
        };
      });
    },

    async getProject(
      actor: AuditActorContext,
      workspaceId: WorkspaceId,
      projectRef: string,
    ): Promise<WorkUseCaseResult<ProjectResponse>> {
      return deps.uow.run(async (repos) => {
        const wsMembership = actor.userId
          ? await repos.memberships.findByWorkspaceAndUser(workspaceId, actor.userId)
          : null;
        const project = await resolveProjectRefInTx(repos, workspaceId, projectRef);
        if (!project) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const role = wsMembership
          ? await resolveActorProjectRole(repos, actor.userId, project)
          : null;
        if (!canReadProject(role)) {
          await appendOutbox(repos, {
            workspaceId: project.workspaceId,
            projectId: project.id,
            eventType: "project.read.denied",
            action: "project.read",
            outcome: "denied",
            actor,
            targetType: "project",
            targetId: project.id,
            reasonCode: "FORBIDDEN",
            payload: { projectId: project.id },
          });
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        const statuses = await repos.statuses.listByProject(project.id);
        const ns = await repos.issueKeys.findNamespaceByProjectId(project.id);
        const prefixes = ns
          ? await repos.issueKeys.listPrefixesByNamespace(ns.id)
          : [];
        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            project: toProjectDto(
              project,
              statuses,
              ns ? toDevProjectSettingsDto(ns, prefixes) : null,
              role ?? undefined,
            ),
          },
        };
      });
    },

    async createTask(
      actor: AuditActorContext,
      projectId: ProjectId,
      input: CreateTaskRequest,
    ): Promise<WorkUseCaseResult<TaskResponse>> {
      if (!isPlainObject(input)) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (!title) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (input.description !== undefined && typeof input.description !== "string") {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        input.inheritParentProject !== undefined &&
        typeof input.inheritParentProject !== "boolean"
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        input.parentTaskId !== undefined &&
        input.parentTaskId !== null &&
        (typeof input.parentTaskId !== "string" ||
          !isValidEntityId("tsk", input.parentTaskId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        input.statusId !== undefined &&
        input.statusId !== null &&
        (typeof input.statusId !== "string" ||
          !isValidEntityId("sts", input.statusId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        input.assigneeId !== undefined &&
        input.assigneeId !== null &&
        (typeof input.assigneeId !== "string" ||
          !isValidEntityId("usr", input.assigneeId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        input.dueOn !== undefined &&
        input.dueOn !== null &&
        (typeof input.dueOn !== "string" || !ISO_DATE_REGEX.test(input.dueOn))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }

      const description =
        typeof input.description === "string" ? input.description : "";

      return deps.uow.run(async (repos) => {
        let effectiveProject = await repos.projects.findById(projectId);
        if (!effectiveProject) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        const parentTaskId = input.parentTaskId ?? null;
        let parentDepth = 0;
        if (parentTaskId) {
          const parentLocked = await lockTaskChainInTx(repos, parentTaskId);
          if (!parentLocked) {
            return fail(404, "NOT_FOUND", "error.notFound");
          }
          if (parentLocked.project.id !== effectiveProject.id) {
            return fail(400, "VALIDATION_ERROR", "error.validation");
          }
          effectiveProject = parentLocked.project;
          parentDepth = parentLocked.depth;
        }

        const storedProjectId =
          parentTaskId && input.inheritParentProject !== false
            ? null
            : effectiveProject.id;

        if (storedProjectId === null && parentDepth + 1 >= MAX_PARENT_HOPS) {
          return fail(400, "VALIDATION_ERROR", "error.validation");
        }

        const role = await resolveActorProjectRole(
          repos,
          actor.userId,
          effectiveProject,
        );
        if (!canWriteProjectTasks(role)) {
          await appendOutbox(repos, {
            workspaceId: effectiveProject.workspaceId,
            projectId: effectiveProject.id,
            eventType: "task.create.denied",
            action: "task.create",
            outcome: "denied",
            actor,
            targetType: "project",
            targetId: effectiveProject.id,
            reasonCode: "FORBIDDEN",
            payload: { title, parentTaskId },
          });
          return fail(403, "FORBIDDEN", "error.forbidden");
        }

        let resolvedStatusId: CreateTaskRequest["statusId"] = input.statusId ?? null;
        if (resolvedStatusId) {
          const status = await repos.statuses.findById(resolvedStatusId);
          if (!status || status.projectId !== effectiveProject.id) {
            return fail(400, "VALIDATION_ERROR", "error.validation");
          }
        } else if (input.statusId === undefined) {
          const projectStatuses = await repos.statuses.listByProject(
            effectiveProject.id,
          );
          resolvedStatusId = projectStatuses[0]?.id ?? null;
        }

        const assigneeId = input.assigneeId ?? null;
        if (assigneeId) {
          const assigneeMembership = await repos.memberships.findByWorkspaceAndUser(
            effectiveProject.workspaceId,
            assigneeId,
          );
          if (!assigneeMembership) {
            return fail(400, "VALIDATION_ERROR", "error.validation");
          }
        }

        const { task, issueKey } = await insertTaskAndIssueKeyInTx(repos, {
          actor,
          effectiveProject,
          storedProjectId,
          parentTaskId,
          statusId: resolvedStatusId,
          title,
          description,
          assigneeId,
          dueOn: input.dueOn ?? null,
          creationKind: parentTaskId ? "subtask" : "create",
        });

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            task: toTaskDto(task, effectiveProject.id, issueKey),
          },
        };
      });
    },

    async getTask(
      actor: AuditActorContext,
      taskRef: string,
      options?: { workspaceId?: WorkspaceId },
    ): Promise<WorkUseCaseResult<TaskResponse>> {
      return deps.uow.run(async (repos) => {
        const resolvedRef = await resolveTaskRefInTx<TaskResponse>(
          repos,
          actor,
          taskRef,
          options,
        );
        if (!resolvedRef.found) {
          if (resolvedRef.deniedTarget) {
            await appendOutbox(repos, {
              workspaceId: resolvedRef.deniedTarget.effectiveProject.workspaceId,
              projectId: resolvedRef.deniedTarget.effectiveProject.id,
              eventType: "task.read.denied",
              action: "task.read",
              outcome: "denied",
              actor,
              targetType: "task",
              targetId: resolvedRef.deniedTarget.task.id,
              reasonCode: "FORBIDDEN",
              payload: {
                taskId: resolvedRef.deniedTarget.task.id,
                projectId: resolvedRef.deniedTarget.effectiveProject.id,
              },
            });
          }
          return resolvedRef.failure;
        }

        const { task, effectiveProject, role } = resolvedRef.ctx;
        if (!canReadProject(role)) {
          await appendOutbox(repos, {
            workspaceId: effectiveProject.workspaceId,
            projectId: effectiveProject.id,
            eventType: "task.read.denied",
            action: "task.read",
            outcome: "denied",
            actor,
            targetType: "task",
            targetId: task.id,
            reasonCode: "FORBIDDEN",
            payload: { taskId: task.id, projectId: effectiveProject.id },
          });
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        const [issueKey, activeNamespace] = await Promise.all([
          repos.issueKeys.findByTaskId(task.id),
          repos.issueKeys.findNamespaceByProjectId(effectiveProject.id),
        ]);

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            task: toTaskDto(
              task,
              effectiveProject.id,
              issueKey,
              activeNamespace !== null,
            ),
          },
        };
      });
    },

    async listProjectTasks(
      actor: AuditActorContext,
      projectId: ProjectId,
    ): Promise<WorkUseCaseResult<TaskListResponse>> {
      return deps.uow.run(async (repos) => {
        const project = await repos.projects.findById(projectId);
        if (!project) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        const role = await resolveActorProjectRole(repos, actor.userId, project);
        if (!canReadProject(role)) {
          await appendOutbox(repos, {
            workspaceId: project.workspaceId,
            projectId: project.id,
            eventType: "project.tasks.read.denied",
            action: "task.list",
            outcome: "denied",
            actor,
            targetType: "project",
            targetId: project.id,
            reasonCode: "FORBIDDEN",
            payload: { projectId: project.id },
          });
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        const collectedTasks = await collectProjectTasksInTx(repos, project.id);
        const activeNamespace = await repos.issueKeys.findNamespaceByProjectId(
          project.id,
        );
        const showKeys = activeNamespace !== null;
        const issueKeysByTaskId = showKeys
          ? await repos.issueKeys.findByTaskIds(collectedTasks.map((t) => t.id))
          : new Map<TaskPublicId, TaskIssueKeyView>();

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            tasks: collectedTasks.map((t) =>
              toTaskDto(
                t,
                project.id,
                issueKeysByTaskId.get(t.id) ?? null,
                showKeys,
              ),
            ),
          },
        };
      });
    },

    async updateTask(
      actor: AuditActorContext,
      taskRef: string,
      patch: UpdateTaskRequest & Record<string, unknown>,
      options?: { workspaceId?: WorkspaceId },
    ): Promise<WorkUseCaseResult<TaskResponse>> {
      if (!isPlainObject(patch)) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if ("id" in patch && patch.id !== undefined) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        patch.title !== undefined &&
        (typeof patch.title !== "string" || patch.title.trim() === "")
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (patch.description !== undefined && typeof patch.description !== "string") {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        patch.projectId !== undefined &&
        (typeof patch.projectId !== "string" ||
          !isValidEntityId("prj", patch.projectId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        patch.statusId !== undefined &&
        patch.statusId !== null &&
        (typeof patch.statusId !== "string" ||
          !isValidEntityId("sts", patch.statusId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        patch.assigneeId !== undefined &&
        patch.assigneeId !== null &&
        (typeof patch.assigneeId !== "string" ||
          !isValidEntityId("usr", patch.assigneeId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        patch.dueOn !== undefined &&
        patch.dueOn !== null &&
        (typeof patch.dueOn !== "string" || !ISO_DATE_REGEX.test(patch.dueOn))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        patch.completedAt !== undefined &&
        patch.completedAt !== null &&
        typeof patch.completedAt !== "string"
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }

      return deps.uow.run(async (repos) => {
        const resolvedRef = await resolveTaskRefInTx<TaskResponse>(
          repos,
          actor,
          taskRef,
          { ...options, lockForWrite: true },
        );
        if (!resolvedRef.found) {
          if (resolvedRef.deniedTarget) {
            await appendOutbox(repos, {
              workspaceId: resolvedRef.deniedTarget.effectiveProject.workspaceId,
              projectId: resolvedRef.deniedTarget.effectiveProject.id,
              eventType: "task.update.denied",
              action: "task.update",
              outcome: "denied",
              actor,
              targetType: "task",
              targetId: resolvedRef.deniedTarget.task.id,
              reasonCode: "FORBIDDEN",
              payload: {
                taskId: resolvedRef.deniedTarget.task.id,
                projectId: resolvedRef.deniedTarget.effectiveProject.id,
              },
            });
          }
          return resolvedRef.failure;
        }

        const {
          task: existing,
          effectiveProject: sourceProject,
          role: sourceRole,
        } = resolvedRef.ctx;
        if (!canReadProject(sourceRole)) {
          await appendOutbox(repos, {
            workspaceId: sourceProject.workspaceId,
            projectId: sourceProject.id,
            eventType: "task.update.denied",
            action: "task.update",
            outcome: "denied",
            actor,
            targetType: "task",
            targetId: existing.id,
            reasonCode: "FORBIDDEN",
            payload: { taskId: existing.id, projectId: sourceProject.id },
          });
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        if (!canWriteProjectTasks(sourceRole)) {
          await appendOutbox(repos, {
            workspaceId: sourceProject.workspaceId,
            projectId: sourceProject.id,
            eventType: "task.update.denied",
            action: "task.update",
            outcome: "denied",
            actor,
            targetType: "task",
            targetId: existing.id,
            reasonCode: "FORBIDDEN",
            payload: { taskId: existing.id, projectId: sourceProject.id },
          });
          return fail(403, "FORBIDDEN", "error.forbidden");
        }

        let targetProject = sourceProject;
        const isMovingProject =
          patch.projectId !== undefined && patch.projectId !== sourceProject.id;
        if (isMovingProject) {
          const requestedTarget = await repos.projects.findById(patch.projectId!);
          if (!requestedTarget) {
            return fail(404, "NOT_FOUND", "error.notFound");
          }
          if (requestedTarget.workspaceId !== sourceProject.workspaceId) {
            return fail(400, "VALIDATION_ERROR", "error.validation");
          }
          const targetRole = await resolveActorProjectRole(
            repos,
            actor.userId,
            requestedTarget,
          );
          if (!canReadProject(targetRole)) {
            await appendOutbox(repos, {
              workspaceId: requestedTarget.workspaceId,
              projectId: requestedTarget.id,
              eventType: "task.move.denied",
              action: "task.move",
              outcome: "denied",
              actor,
              targetType: "project",
              targetId: requestedTarget.id,
              reasonCode: "FORBIDDEN",
              payload: { taskId: existing.id, projectId: requestedTarget.id },
            });
            return fail(404, "NOT_FOUND", "error.notFound");
          }
          if (!canWriteProjectTasks(targetRole)) {
            await appendOutbox(repos, {
              workspaceId: requestedTarget.workspaceId,
              projectId: requestedTarget.id,
              eventType: "task.move.denied",
              action: "task.move",
              outcome: "denied",
              actor,
              targetType: "project",
              targetId: requestedTarget.id,
              reasonCode: "FORBIDDEN",
              payload: { taskId: existing.id, projectId: requestedTarget.id },
            });
            return fail(403, "FORBIDDEN", "error.forbidden");
          }
          targetProject = requestedTarget;
        }

        let resolvedStatusId: StatusId | null | undefined = patch.statusId;
        let prefetchedTargetStatuses: ProjectStatusRecord[] | undefined;
        if (patch.statusId !== undefined && patch.statusId !== null) {
          const status = await repos.statuses.findById(patch.statusId);
          if (!status || status.projectId !== targetProject.id) {
            return fail(400, "VALIDATION_ERROR", "error.validation");
          }
        } else if (isMovingProject && patch.statusId === undefined) {
          prefetchedTargetStatuses = await repos.statuses.listByProject(
            targetProject.id,
          );
          resolvedStatusId = prefetchedTargetStatuses[0]?.id ?? null;
        }

        if (patch.assigneeId !== undefined && patch.assigneeId !== null) {
          const assigneeMembership = await repos.memberships.findByWorkspaceAndUser(
            targetProject.workspaceId,
            patch.assigneeId,
          );
          if (!assigneeMembership) {
            return fail(400, "VALIDATION_ERROR", "error.validation");
          }
        }

        const nowIso = deps.clock.now().toISOString();
        const updated = await repos.tasks.update(existing.id, {
          ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description }
            : {}),
          ...(isMovingProject
            ? { projectId: targetProject.id, parentTaskId: null }
            : {}),
          ...(resolvedStatusId !== undefined
            ? { statusId: resolvedStatusId }
            : {}),
          ...(patch.assigneeId !== undefined
            ? { assigneeId: patch.assigneeId }
            : {}),
          ...(patch.dueOn !== undefined ? { dueOn: patch.dueOn } : {}),
          ...(patch.completedAt !== undefined
            ? { completedAt: patch.completedAt }
            : {}),
          updatedAt: nowIso,
        });
        if (!updated) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        if (isMovingProject) {
          const { movingInheritedDescendants, detachChildIds } =
            await partitionMovingSubtreeInTx(
              repos,
              existing.id,
              targetProject.id,
            );
          if (detachChildIds.length > 0) {
            await repos.tasks.clearParentTaskIds(detachChildIds, nowIso);
          }
          await remapMovingSubtreeStatusesInTx(
            repos,
            movingInheritedDescendants,
            sourceProject.id,
            targetProject.id,
            prefetchedTargetStatuses,
            nowIso,
          );
          await assignMissingKeysForSubtreeInTx(
            repos,
            updated,
            movingInheritedDescendants,
            targetProject,
            nowIso,
          );
        }

        await appendOutbox(repos, {
          workspaceId: targetProject.workspaceId,
          projectId: targetProject.id,
          eventType: isMovingProject ? "task.moved" : "task.updated",
          action: isMovingProject ? "task.move" : "task.update",
          outcome: "succeeded",
          actor,
          targetType: "task",
          targetId: updated.id,
          reasonCode: null,
          payload: {
            taskId: updated.id,
            projectId: targetProject.id,
            ...(isMovingProject ? { fromProjectId: sourceProject.id } : {}),
            changes: {
              ...(patch.title !== undefined ? { title: updated.title } : {}),
              ...(patch.description !== undefined
                ? { description: updated.description }
                : {}),
              ...(isMovingProject ? { projectId: updated.projectId } : {}),
              ...(resolvedStatusId !== undefined
                ? { statusId: updated.statusId }
                : {}),
              ...(patch.assigneeId !== undefined
                ? { assigneeId: updated.assigneeId }
                : {}),
              ...(patch.dueOn !== undefined ? { dueOn: updated.dueOn } : {}),
              ...(patch.completedAt !== undefined
                ? { completedAt: updated.completedAt }
                : {}),
            },
          },
        });

        const [issueKey, activeNamespace] = await Promise.all([
          repos.issueKeys.findByTaskId(updated.id),
          repos.issueKeys.findNamespaceByProjectId(targetProject.id),
        ]);

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            task: toTaskDto(
              updated,
              targetProject.id,
              issueKey,
              activeNamespace !== null,
            ),
          },
        };
      });
    },

    async moveTask(
      actor: AuditActorContext,
      taskRef: string,
      input: MoveTaskRequest & Record<string, unknown>,
      options?: { workspaceId?: WorkspaceId },
    ): Promise<WorkUseCaseResult<TaskResponse>> {
      if (!isPlainObject(input)) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        typeof input.projectId !== "string" ||
        !isValidEntityId("prj", input.projectId)
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        input.statusId !== undefined &&
        input.statusId !== null &&
        (typeof input.statusId !== "string" ||
          !isValidEntityId("sts", input.statusId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      return this.updateTask(
        actor,
        taskRef,
        {
          projectId: input.projectId,
          ...(input.statusId !== undefined ? { statusId: input.statusId } : {}),
        },
        options,
      );
    },

    async searchTasks(
      actor: AuditActorContext,
      workspaceId: WorkspaceId,
      input: {
        query?: string;
        projectRef?: string;
        limit?: number;
      },
    ): Promise<WorkUseCaseResult<TaskSearchResponse>> {
      const rawQuery = typeof input.query === "string" ? input.query : "";
      const trimmedQuery = rawQuery.trim();
      const rawLimit =
        typeof input.limit === "number" && Number.isFinite(input.limit)
          ? Math.trunc(input.limit)
          : 20;
      const limit = Math.min(Math.max(rawLimit, 1), 100);

      return deps.uow.run(async (repos) => {
        const wsMembership = actor.userId
          ? await repos.memberships.findByWorkspaceAndUser(workspaceId, actor.userId)
          : null;
        if (!wsMembership) {
          await appendOutbox(repos, {
            workspaceId: null,
            projectId: null,
            eventType: "task.search.denied",
            action: "task.search",
            outcome: "denied",
            actor,
            targetType: "workspace",
            targetId: workspaceId,
            reasonCode: "FORBIDDEN",
            payload: { workspaceId },
          });
          return fail(403, "FORBIDDEN", "error.forbidden");
        }

        const allProjects = await repos.projects.listByWorkspace(workspaceId);
        const readableProjects: ProjectRecord[] = [];
        for (const project of allProjects) {
          const role = await resolveActorProjectRole(repos, actor.userId, project);
          if (canReadProject(role)) {
            readableProjects.push(project);
          }
        }
        const readableIds = new Set(readableProjects.map((p) => p.id));

        let allowedProjects = readableProjects;
        if (input.projectRef !== undefined && input.projectRef.trim() !== "") {
          const scopedProject = await resolveProjectRefInTx(
            repos,
            workspaceId,
            input.projectRef,
          );
          if (!scopedProject || !readableIds.has(scopedProject.id)) {
            await appendOutbox(repos, {
              workspaceId,
              projectId: scopedProject?.id ?? null,
              eventType: "task.search.denied",
              action: "task.search",
              outcome: "denied",
              actor,
              targetType: "project",
              targetId: scopedProject?.id ?? input.projectRef.trim(),
              reasonCode: "FORBIDDEN",
              payload: { workspaceId, projectRef: input.projectRef.trim() },
            });
            return fail(404, "NOT_FOUND", "error.notFound");
          }
          allowedProjects = [scopedProject];
        }

        const allowedProjectMap = new Map<ProjectId, ProjectRecord>(
          allowedProjects.map((p) => [p.id, p]),
        );
        const allowedProjectIds = Array.from(allowedProjectMap.keys());
        const activeNamespaces = await repos.issueKeys.findNamespacesByProjectIds(
          allowedProjectIds,
        );
        const devProjectIds = new Set<ProjectId>(
          activeNamespaces
            .map((ns) => ns.projectId)
            .filter((id): id is ProjectId => id !== null),
        );

        let exactEntry: {
          task: TaskRecord;
          effectiveProjectId: ProjectId;
          matchKind: TaskSearchMatchKind;
        } | null = null;

        if (isValidEntityId("tsk", trimmedQuery)) {
          const candidate = await repos.tasks.findById(trimmedQuery);
          if (candidate && candidate.workspaceId === workspaceId) {
            const resolved = await resolveTaskEffectiveProject(repos, candidate);
            if (resolved && allowedProjectMap.has(resolved.project.id)) {
              exactEntry = {
                task: candidate,
                effectiveProjectId: resolved.project.id,
                matchKind: "exact_id",
              };
            }
          }
        } else {
          const parsedKey = parseIssueKey(trimmedQuery);
          if (parsedKey) {
            const candidateId = await repos.issueKeys.findTaskIdByWorkspaceKey(
              workspaceId,
              parsedKey.prefix,
              parsedKey.number,
            );
            if (candidateId) {
              const candidate = await repos.tasks.findById(candidateId);
              if (candidate && candidate.workspaceId === workspaceId) {
                const resolved = await resolveTaskEffectiveProject(repos, candidate);
                if (resolved && allowedProjectMap.has(resolved.project.id)) {
                  exactEntry = {
                    task: candidate,
                    effectiveProjectId: resolved.project.id,
                    matchKind: "exact_key",
                  };
                }
              }
            }
          }
        }

        const selected: Array<{
          task: TaskRecord;
          effectiveProjectId: ProjectId;
          matchKind: TaskSearchMatchKind;
        }> = [];
        const seenTaskIds = new Set<TaskPublicId>();
        if (exactEntry) {
          selected.push(exactEntry);
          seenTaskIds.add(exactEntry.task.id);
        }

        const pageSize = Math.min(Math.max(limit * 4, 50), 200);
        let cursor: { updatedAt: string; id: TaskPublicId } | undefined;
        const resolvedProjectCache = new Map<TaskPublicId, ProjectRecord | null>();

        while (selected.length < limit) {
          const textCandidates = await repos.tasks.searchInWorkspace({
            workspaceId,
            allowedProjectIds,
            query: trimmedQuery,
            limit: pageSize,
            ...(cursor ? { before: cursor } : {}),
          });
          if (textCandidates.length === 0) {
            break;
          }

          for (const candidate of textCandidates) {
            if (selected.length >= limit) {
              break;
            }
            if (seenTaskIds.has(candidate.id)) {
              continue;
            }
            seenTaskIds.add(candidate.id);
            let effectiveProject: ProjectRecord | null = null;
            if (candidate.projectId) {
              effectiveProject = allowedProjectMap.get(candidate.projectId) ?? null;
            } else if (resolvedProjectCache.has(candidate.id)) {
              effectiveProject = resolvedProjectCache.get(candidate.id) ?? null;
            } else {
              const resolved = await resolveTaskEffectiveProject(repos, candidate);
              effectiveProject = resolved
                ? (allowedProjectMap.get(resolved.project.id) ?? null)
                : null;
              resolvedProjectCache.set(candidate.id, effectiveProject);
            }
            if (!effectiveProject) {
              continue;
            }
            selected.push({
              task: candidate,
              effectiveProjectId: effectiveProject.id,
              matchKind: "text",
            });
          }

          if (textCandidates.length < pageSize) {
            break;
          }
          const last = textCandidates[textCandidates.length - 1]!;
          cursor = { updatedAt: last.updatedAt, id: last.id };
        }

        const issueKeysByTaskId = await repos.issueKeys.findByTaskIds(
          selected.map((s) => s.task.id),
        );

        const items: TaskSearchItemDto[] = selected.map((entry) => ({
          matchKind: entry.matchKind,
          task: toTaskDto(
            entry.task,
            entry.effectiveProjectId,
            issueKeysByTaskId.get(entry.task.id) ?? null,
            devProjectIds.has(entry.effectiveProjectId),
          ),
        }));

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            query: rawQuery,
            items,
          },
        };
      });
    },

    async copyTask(
      actor: AuditActorContext,
      sourceTaskRef: string,
      input: CopyTaskRequest & Record<string, unknown>,
      options?: { workspaceId?: WorkspaceId },
    ): Promise<WorkUseCaseResult<TaskResponse>> {
      if (!isPlainObject(input)) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        input.title !== undefined &&
        (typeof input.title !== "string" || input.title.trim() === "")
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        input.projectId !== undefined &&
        (typeof input.projectId !== "string" ||
          !isValidEntityId("prj", input.projectId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        input.parentTaskId !== undefined &&
        input.parentTaskId !== null &&
        (typeof input.parentTaskId !== "string" ||
          !isValidEntityId("tsk", input.parentTaskId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        input.inheritParentProject !== undefined &&
        typeof input.inheritParentProject !== "boolean"
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }

      return deps.uow.run(async (repos) => {
        const resolvedRef = await resolveTaskRefInTx<TaskResponse>(
          repos,
          actor,
          sourceTaskRef,
          { ...options, lockForWrite: true },
        );
        if (!resolvedRef.found) {
          if (resolvedRef.deniedTarget) {
            await appendOutbox(repos, {
              workspaceId: resolvedRef.deniedTarget.effectiveProject.workspaceId,
              projectId: resolvedRef.deniedTarget.effectiveProject.id,
              eventType: "task.copy.denied",
              action: "task.copy",
              outcome: "denied",
              actor,
              targetType: "task",
              targetId: resolvedRef.deniedTarget.task.id,
              reasonCode: "FORBIDDEN",
              payload: {
                taskId: resolvedRef.deniedTarget.task.id,
                projectId: resolvedRef.deniedTarget.effectiveProject.id,
              },
            });
          }
          return resolvedRef.failure;
        }
        const {
          task: sourceTask,
          effectiveProject: sourceProject,
          role: sourceRole,
        } = resolvedRef.ctx;
        if (!canReadProject(sourceRole)) {
          await appendOutbox(repos, {
            workspaceId: sourceProject.workspaceId,
            projectId: sourceProject.id,
            eventType: "task.copy.denied",
            action: "task.copy",
            outcome: "denied",
            actor,
            targetType: "task",
            targetId: sourceTask.id,
            reasonCode: "FORBIDDEN",
            payload: { taskId: sourceTask.id, projectId: sourceProject.id },
          });
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        let targetProject = sourceProject;
        if (input.projectId !== undefined && input.projectId !== sourceProject.id) {
          const requestedTarget = await repos.projects.findById(input.projectId);
          if (!requestedTarget) {
            return fail(404, "NOT_FOUND", "error.notFound");
          }
          if (requestedTarget.workspaceId !== sourceProject.workspaceId) {
            return fail(400, "VALIDATION_ERROR", "error.validation");
          }
          targetProject = requestedTarget;
        }

        const targetRole = await resolveActorProjectRole(
          repos,
          actor.userId,
          targetProject,
        );
        if (!canReadProject(targetRole)) {
          await appendOutbox(repos, {
            workspaceId: targetProject.workspaceId,
            projectId: targetProject.id,
            eventType: "task.copy.denied",
            action: "task.copy",
            outcome: "denied",
            actor,
            targetType: "project",
            targetId: targetProject.id,
            reasonCode: "FORBIDDEN",
            payload: { sourceTaskId: sourceTask.id, projectId: targetProject.id },
          });
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        if (!canWriteProjectTasks(targetRole)) {
          await appendOutbox(repos, {
            workspaceId: targetProject.workspaceId,
            projectId: targetProject.id,
            eventType: "task.copy.denied",
            action: "task.copy",
            outcome: "denied",
            actor,
            targetType: "project",
            targetId: targetProject.id,
            reasonCode: "FORBIDDEN",
            payload: { sourceTaskId: sourceTask.id, projectId: targetProject.id },
          });
          return fail(403, "FORBIDDEN", "error.forbidden");
        }

        const parentTaskId = input.parentTaskId ?? null;
        let parentDepth = 0;
        if (parentTaskId) {
          const parentLocked = await lockTaskChainInTx(repos, parentTaskId);
          if (!parentLocked) {
            return fail(404, "NOT_FOUND", "error.notFound");
          }
          if (parentLocked.project.id !== targetProject.id) {
            return fail(400, "VALIDATION_ERROR", "error.validation");
          }
          parentDepth = parentLocked.depth;
        }

        const storedProjectId =
          parentTaskId && input.inheritParentProject !== false
            ? null
            : targetProject.id;

        if (storedProjectId === null && parentDepth + 1 >= MAX_PARENT_HOPS) {
          return fail(400, "VALIDATION_ERROR", "error.validation");
        }

        let resolvedStatusId: StatusId | null = null;
        if (targetProject.id === sourceProject.id) {
          resolvedStatusId = sourceTask.statusId;
        } else {
          const targetStatuses = await repos.statuses.listByProject(targetProject.id);
          resolvedStatusId = targetStatuses[0]?.id ?? null;
        }

        const { task, issueKey } = await insertTaskAndIssueKeyInTx(repos, {
          actor,
          effectiveProject: targetProject,
          storedProjectId,
          parentTaskId,
          statusId: resolvedStatusId,
          title:
            typeof input.title === "string" ? input.title.trim() : sourceTask.title,
          description: sourceTask.description,
          assigneeId: sourceTask.assigneeId,
          dueOn: sourceTask.dueOn,
          creationKind: "copy",
          copiedFromTaskId: sourceTask.id,
        });

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            task: toTaskDto(task, targetProject.id, issueKey),
          },
        };
      });
    },

    async deleteTask(
      actor: AuditActorContext,
      taskRef: string,
      options?: { workspaceId?: WorkspaceId },
    ): Promise<WorkUseCaseResult<DeleteTaskResponse>> {
      return deps.uow.run(async (repos) => {
        const resolvedRef = await resolveTaskRefInTx<DeleteTaskResponse>(
          repos,
          actor,
          taskRef,
          { ...options, lockForWrite: true },
        );
        if (!resolvedRef.found) {
          if (resolvedRef.deniedTarget) {
            await appendOutbox(repos, {
              workspaceId: resolvedRef.deniedTarget.effectiveProject.workspaceId,
              projectId: resolvedRef.deniedTarget.effectiveProject.id,
              eventType: "task.delete.denied",
              action: "task.delete",
              outcome: "denied",
              actor,
              targetType: "task",
              targetId: resolvedRef.deniedTarget.task.id,
              reasonCode: "FORBIDDEN",
              payload: {
                taskId: resolvedRef.deniedTarget.task.id,
                projectId: resolvedRef.deniedTarget.effectiveProject.id,
              },
            });
          }
          return resolvedRef.failure;
        }

        const { task: existing, effectiveProject, role } = resolvedRef.ctx;
        if (!canReadProject(role)) {
          await appendOutbox(repos, {
            workspaceId: effectiveProject.workspaceId,
            projectId: effectiveProject.id,
            eventType: "task.delete.denied",
            action: "task.delete",
            outcome: "denied",
            actor,
            targetType: "task",
            targetId: existing.id,
            reasonCode: "FORBIDDEN",
            payload: { taskId: existing.id, projectId: effectiveProject.id },
          });
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        if (!canWriteProjectTasks(role)) {
          await appendOutbox(repos, {
            workspaceId: effectiveProject.workspaceId,
            projectId: effectiveProject.id,
            eventType: "task.delete.denied",
            action: "task.delete",
            outcome: "denied",
            actor,
            targetType: "task",
            targetId: existing.id,
            reasonCode: "FORBIDDEN",
            payload: { taskId: existing.id, projectId: effectiveProject.id },
          });
          return fail(403, "FORBIDDEN", "error.forbidden");
        }

        const existingKey = await repos.issueKeys.findByTaskId(existing.id);
        const deleted = await repos.tasks.deleteById(existing.id);
        if (!deleted) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        await appendOutbox(repos, {
          workspaceId: effectiveProject.workspaceId,
          projectId: effectiveProject.id,
          eventType: "task.deleted",
          action: "task.delete",
          outcome: "succeeded",
          actor,
          targetType: "task",
          targetId: existing.id,
          reasonCode: null,
          payload: {
            taskId: existing.id,
            projectId: effectiveProject.id,
            issueKey: existingKey
              ? formatIssueKey(existingKey.currentPrefix, existingKey.issueNumber)
              : null,
          },
        });

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            deletedTaskId: existing.id,
          },
        };
      });
    },

    async getWorkspaceSettings(
      actor: AuditActorContext,
      workspaceId: WorkspaceId,
    ): Promise<WorkUseCaseResult<WorkspaceSettingsResponse>> {
      return deps.uow.run(async (repos) => {
        const workspace = await repos.workspaces.findById(workspaceId);
        if (!workspace) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const membership = actor.userId
          ? await repos.memberships.findByWorkspaceAndUser(
              workspaceId,
              actor.userId,
            )
          : null;
        if (!membership) {
          await appendOutbox(repos, {
            workspaceId: null,
            projectId: null,
            eventType: "workspace.settings.read.denied",
            action: "workspace.settings.read",
            outcome: "denied",
            actor,
            targetType: "workspace",
            targetId: workspaceId,
            reasonCode: "FORBIDDEN",
            payload: { workspaceId },
          });
          return fail(403, "FORBIDDEN", "error.forbidden");
        }

        const record = await repos.workspaceSettings.findByWorkspaceId(workspaceId);
        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            settings: toWorkspaceSettingsDto(
              workspaceId,
              record,
              workspace.updatedAt,
            ),
          },
        };
      });
    },

    async updateWorkspaceSettings(
      actor: AuditActorContext,
      workspaceId: WorkspaceId,
      input: UpdateWorkspaceSettingsRequest & Record<string, unknown>,
    ): Promise<WorkUseCaseResult<WorkspaceSettingsResponse>> {
      if (!isPlainObject(input)) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      const hasEnabled = input.devProjectsEnabled !== undefined;
      const hasLocale = input.defaultLocale !== undefined;
      if (!hasEnabled && !hasLocale) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (hasEnabled && typeof input.devProjectsEnabled !== "boolean") {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        hasLocale &&
        (typeof input.defaultLocale !== "string" ||
          input.defaultLocale.trim() === "")
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }

      return deps.uow.run(async (repos) => {
        const workspace = await repos.workspaces.findById(workspaceId);
        if (!workspace) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const membership = actor.userId
          ? await repos.memberships.findByWorkspaceAndUser(
              workspaceId,
              actor.userId,
            )
          : null;
        if (!membership || membership.role !== "admin") {
          await appendOutbox(repos, {
            workspaceId,
            projectId: null,
            eventType: "workspace.settings.update.denied",
            action: "workspace.settings.update",
            outcome: "denied",
            actor,
            targetType: "workspace",
            targetId: workspaceId,
            reasonCode: "FORBIDDEN",
            payload: { workspaceId },
          });
          return fail(403, "FORBIDDEN", "error.forbidden");
        }

        const nowIso = deps.clock.now().toISOString();
        const saved = await repos.workspaceSettings.patch({
          workspaceId,
          ...(hasLocale
            ? { defaultLocale: (input.defaultLocale as string).trim() as LocaleCode }
            : {}),
          ...(hasEnabled
            ? { devProjectsEnabled: input.devProjectsEnabled as boolean }
            : {}),
          updatedAt: nowIso,
        });

        await appendOutbox(repos, {
          workspaceId,
          projectId: null,
          eventType: "workspace.settings.updated",
          action: "workspace.settings.update",
          outcome: "succeeded",
          actor,
          targetType: "workspace",
          targetId: workspaceId,
          reasonCode: null,
          payload: {
            workspaceId,
            devProjectsEnabled: saved.devProjectsEnabled,
            defaultLocale: saved.defaultLocale,
          },
        });

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            settings: toWorkspaceSettingsDto(workspaceId, saved, nowIso),
          },
        };
      });
    },

    async getProjectDevSettings(
      actor: AuditActorContext,
      projectId: ProjectId,
    ): Promise<WorkUseCaseResult<ProjectDevSettingsResponse>> {
      return deps.uow.run(async (repos) => {
        const project = await repos.projects.findById(projectId);
        if (!project) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const role = await resolveActorProjectRole(repos, actor.userId, project);
        if (!canReadProject(role)) {
          await appendOutbox(repos, {
            workspaceId: project.workspaceId,
            projectId: project.id,
            eventType: "project.dev_settings.read.denied",
            action: "project.dev_settings.read",
            outcome: "denied",
            actor,
            targetType: "project",
            targetId: project.id,
            reasonCode: "FORBIDDEN",
            payload: { projectId: project.id },
          });
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        const wsSettings = await repos.workspaceSettings.findByWorkspaceId(
          project.workspaceId,
        );
        const statuses = await repos.statuses.listByProject(project.id);
        const namespace = await repos.issueKeys.findNamespaceByProjectId(
          project.id,
        );
        const prefixes = namespace
          ? await repos.issueKeys.listPrefixesByNamespace(namespace.id)
          : [];

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            allowed: wsSettings?.devProjectsEnabled ?? false,
            canManage: canManageProject(role),
            dev: namespace ? toDevProjectSettingsDto(namespace, prefixes) : null,
            statuses: statuses.map(toStatusDto),
          },
        };
      });
    },

    async enableDevProject(
      actor: AuditActorContext,
      projectId: ProjectId,
      input: EnableDevProjectRequest & Record<string, unknown>,
    ): Promise<WorkUseCaseResult<EnableDevProjectResponse>> {
      if (!isPlainObject(input)) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      const prefix = normalizeDevPrefix(input.prefix);
      if (!prefix) {
        return fail(400, "VALIDATION_ERROR", "error.invalidDevPrefix");
      }
      if (
        input.startStatusId !== undefined &&
        input.startStatusId !== null &&
        (typeof input.startStatusId !== "string" ||
          !isValidEntityId("sts", input.startStatusId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }

      return runWorkTx(deps.uow, async (repos) => {
        // Lock the project row FOR UPDATE on Postgres so concurrent task creation waits and never skips keys.
        const project = await repos.projects.findByIdForUpdate(projectId);
        if (!project) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        const role = await resolveActorProjectRole(repos, actor.userId, project);
        if (!canReadProject(role)) {
          await appendOutbox(repos, {
            workspaceId: project.workspaceId,
            projectId: project.id,
            eventType: "project.dev_enable.denied",
            action: "project.dev_enable",
            outcome: "denied",
            actor,
            targetType: "project",
            targetId: project.id,
            reasonCode: "FORBIDDEN",
            payload: { projectId: project.id },
          });
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        if (!canManageProject(role)) {
          await appendOutbox(repos, {
            workspaceId: project.workspaceId,
            projectId: project.id,
            eventType: "project.dev_enable.denied",
            action: "project.dev_enable",
            outcome: "denied",
            actor,
            targetType: "project",
            targetId: project.id,
            reasonCode: "FORBIDDEN",
            payload: { projectId: project.id },
          });
          return fail(403, "FORBIDDEN", "error.forbidden");
        }

        const wsSettings = await repos.workspaceSettings.findByWorkspaceId(
          project.workspaceId,
        );
        if (!wsSettings?.devProjectsEnabled) {
          await appendOutbox(repos, {
            workspaceId: project.workspaceId,
            projectId: project.id,
            eventType: "project.dev_enable.denied",
            action: "project.dev_enable",
            outcome: "denied",
            actor,
            targetType: "project",
            targetId: project.id,
            reasonCode: "DEV_PROJECTS_DISABLED",
            payload: { projectId: project.id },
          });
          return fail(403, "FORBIDDEN", "error.devProjectsDisabled");
        }

        const existingNamespace = await repos.issueKeys.findNamespaceByProjectId(
          project.id,
        );
        if (existingNamespace) {
          return fail(409, "CONFLICT", "error.devProjectAlreadyEnabled");
        }

        const projectStatuses = await repos.statuses.listByProject(project.id);
        let resolvedStartStatusId: StatusId | null = null;
        if (input.startStatusId !== undefined) {
          if (input.startStatusId !== null) {
            const matched = projectStatuses.find(
              (s) => s.id === input.startStatusId,
            );
            if (!matched) {
              return fail(400, "VALIDATION_ERROR", "error.validation");
            }
            resolvedStartStatusId = matched.id;
          }
        } else {
          resolvedStartStatusId =
            projectStatuses.find((s) => s.category === "in_progress")?.id ??
            null;
        }

        const prefixOwner = await repos.issueKeys.findPrefixOwner(
          project.workspaceId,
          prefix,
        );
        if (prefixOwner) {
          return fail(409, "CONFLICT", "error.prefixAlreadyInUse");
        }

        const projectTasks = await collectProjectTasksInTx(repos, project.id);
        const existingKeys = await repos.issueKeys.findByTaskIds(
          projectTasks.map((t) => t.id),
        );
        const unkeyedTasks = projectTasks
          .filter((t) => !existingKeys.has(t.id))
          .sort((a, b) => {
            if (a.createdAt !== b.createdAt) {
              return a.createdAt < b.createdAt ? -1 : 1;
            }
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          });

        if (unkeyedTasks.length > DEV_PROJECT_ENABLE_MAX_TASKS) {
          return fail(409, "CONFLICT", "error.conflict");
        }

        const nowIso = deps.clock.now().toISOString();
        if (project.kind !== "development") {
          await repos.projects.updateKind(project.id, "development", nowIso);
        }

        const namespace = await repos.issueKeys.createNamespace({
          id: deps.idGenerator.next("ins"),
          workspaceId: project.workspaceId,
          projectId: project.id,
          currentPrefix: prefix,
          branchPrefix: prefix.toLowerCase(),
          startStatusId: resolvedStartStatusId,
          enabledBy: actor.userId,
          enabledAt: nowIso,
        });

        const reservedPrefix = await repos.issueKeys.reservePrefix({
          workspaceId: project.workspaceId,
          prefix,
          namespaceId: namespace.id,
          createdAt: nowIso,
        });
        if (!reservedPrefix) {
          throw new RollbackWorkResultError(
            fail(409, "CONFLICT", "error.prefixAlreadyInUse"),
          );
        }

        await repos.issueKeys.initCounter(namespace.id, 1 + unkeyedTasks.length);
        await repos.issueKeys.createTaskKeys(
          unkeyedTasks.map((task, idx) => ({
            taskId: task.id,
            namespaceId: namespace.id,
            issueNumber: idx + 1,
            createdAt: nowIso,
          })),
        );

        await appendOutbox(repos, {
          workspaceId: project.workspaceId,
          projectId: project.id,
          eventType: "project.dev_enabled",
          action: "project.dev_enable",
          outcome: "succeeded",
          actor,
          targetType: "project",
          targetId: project.id,
          reasonCode: null,
          payload: {
            projectId: project.id,
            namespaceId: namespace.id,
            prefix: namespace.currentPrefix,
            branchPrefix: namespace.branchPrefix,
            startStatusId: namespace.startStatusId,
            keyedCount: unkeyedTasks.length,
          },
        });

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            allowed: true,
            dev: toDevProjectSettingsDto(namespace, [reservedPrefix]),
            keyedCount: unkeyedTasks.length,
          },
        };
      });
    },

    async updateDevProjectSettings(
      actor: AuditActorContext,
      projectId: ProjectId,
      input: UpdateDevProjectSettingsRequest & Record<string, unknown>,
    ): Promise<WorkUseCaseResult<ProjectDevSettingsResponse>> {
      if (!isPlainObject(input)) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      const hasPrefix = input.prefix !== undefined;
      const hasStart = input.startStatusId !== undefined;
      if (!hasPrefix && !hasStart) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }

      let nextPrefix: string | undefined;
      if (hasPrefix) {
        const normalized = normalizeDevPrefix(input.prefix);
        if (!normalized) {
          return fail(400, "VALIDATION_ERROR", "error.invalidDevPrefix");
        }
        nextPrefix = normalized;
      }

      if (
        hasStart &&
        input.startStatusId !== null &&
        (typeof input.startStatusId !== "string" ||
          !isValidEntityId("sts", input.startStatusId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }

      return runWorkTx(deps.uow, async (repos) => {
        const project = await repos.projects.findById(projectId);
        if (!project) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        const role = await resolveActorProjectRole(repos, actor.userId, project);
        if (!canReadProject(role)) {
          await appendOutbox(repos, {
            workspaceId: project.workspaceId,
            projectId: project.id,
            eventType: "project.dev_settings.update.denied",
            action: "project.dev_settings.update",
            outcome: "denied",
            actor,
            targetType: "project",
            targetId: project.id,
            reasonCode: "FORBIDDEN",
            payload: { projectId: project.id },
          });
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        if (!canManageProject(role)) {
          await appendOutbox(repos, {
            workspaceId: project.workspaceId,
            projectId: project.id,
            eventType: "project.dev_settings.update.denied",
            action: "project.dev_settings.update",
            outcome: "denied",
            actor,
            targetType: "project",
            targetId: project.id,
            reasonCode: "FORBIDDEN",
            payload: { projectId: project.id },
          });
          return fail(403, "FORBIDDEN", "error.forbidden");
        }

        const wsSettings = await repos.workspaceSettings.findByWorkspaceId(
          project.workspaceId,
        );
        if (!wsSettings?.devProjectsEnabled) {
          await appendOutbox(repos, {
            workspaceId: project.workspaceId,
            projectId: project.id,
            eventType: "project.dev_settings.update.denied",
            action: "project.dev_settings.update",
            outcome: "denied",
            actor,
            targetType: "project",
            targetId: project.id,
            reasonCode: "DEV_PROJECTS_DISABLED",
            payload: { projectId: project.id },
          });
          return fail(403, "FORBIDDEN", "error.devProjectsDisabled");
        }

        const currentNamespace =
          await repos.issueKeys.findNamespaceByProjectIdForUpdate(project.id);
        if (!currentNamespace) {
          return fail(409, "CONFLICT", "error.devProjectNotEnabled");
        }

        const projectStatuses = await repos.statuses.listByProject(project.id);
        if (hasStart && input.startStatusId !== null) {
          const matched = projectStatuses.find(
            (s) => s.id === input.startStatusId,
          );
          if (!matched) {
            return fail(400, "VALIDATION_ERROR", "error.validation");
          }
        }

        const nowIso = deps.clock.now().toISOString();
        let prefixChanged = false;
        if (
          nextPrefix !== undefined &&
          nextPrefix !== currentNamespace.currentPrefix
        ) {
          const owner = await repos.issueKeys.findPrefixOwner(
            project.workspaceId,
            nextPrefix,
          );
          if (owner && owner.namespaceId !== currentNamespace.id) {
            return fail(409, "CONFLICT", "error.prefixAlreadyInUse");
          }
          if (!owner) {
            const reserved = await repos.issueKeys.reservePrefix({
              workspaceId: project.workspaceId,
              prefix: nextPrefix,
              namespaceId: currentNamespace.id,
              createdAt: nowIso,
            });
            if (!reserved) {
              throw new RollbackWorkResultError(
                fail(409, "CONFLICT", "error.prefixAlreadyInUse"),
              );
            }
          }
          prefixChanged = true;
        }

        const updatedNamespace = await repos.issueKeys.updateNamespace(
          currentNamespace.id,
          {
            ...(prefixChanged ? { currentPrefix: nextPrefix } : {}),
            ...(hasStart ? { startStatusId: input.startStatusId ?? null } : {}),
            updatedAt: nowIso,
          },
        );
        if (!updatedNamespace) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        const allPrefixes = await repos.issueKeys.listPrefixesByNamespace(
          updatedNamespace.id,
        );

        await appendOutbox(repos, {
          workspaceId: project.workspaceId,
          projectId: project.id,
          eventType: "project.dev_settings.updated",
          action: "project.dev_settings.update",
          outcome: "succeeded",
          actor,
          targetType: "project",
          targetId: project.id,
          reasonCode: null,
          payload: {
            projectId: project.id,
            namespaceId: updatedNamespace.id,
            prefix: updatedNamespace.currentPrefix,
            branchPrefix: updatedNamespace.branchPrefix,
            startStatusId: updatedNamespace.startStatusId,
          },
        });

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            allowed: true,
            canManage: true,
            dev: toDevProjectSettingsDto(updatedNamespace, allPrefixes),
            statuses: projectStatuses.map(toStatusDto),
          },
        };
      });
    },
  };
}
