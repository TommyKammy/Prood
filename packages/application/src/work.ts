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
  type OutboxEventDto,
  type ProjectDevSettingsResponse,
  type ProjectDto,
  type ProjectListResponse,
  type ProjectResponse,
  type ProjectStatusDto,
  type TaskDto,
  type TaskListResponse,
  type TaskResponse,
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
  resolveEffectiveProjectRole,
  type AuditActorContext,
  type EventChannel,
  type LocaleCode,
  type ProjectId,
  type ProjectRole,
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
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function toTaskDto(
  task: TaskRecord,
  effectiveProjectId: ProjectId,
  issueKeyView: TaskIssueKeyView | null = null,
): TaskDto {
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    effectiveProjectId,
    parentTaskId: task.parentTaskId,
    statusId: task.statusId,
    issueKey: issueKeyView
      ? formatIssueKey(issueKeyView.currentPrefix, issueKeyView.issueNumber)
      : null,
    branchName: issueKeyView
      ? formatBranchName(issueKeyView.branchPrefix, issueKeyView.issueNumber)
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

  async function collectProjectTasksInTx(
    repos: TransactionRepositories,
    projectId: ProjectId,
  ): Promise<TaskRecord[]> {
    const directTasks = await repos.tasks.listByProject(projectId);
    const collected = new Map<TaskPublicId, TaskRecord>();
    let frontier: TaskPublicId[] = [];
    for (const task of directTasks) {
      collected.set(task.id, task);
      frontier.push(task.id);
    }

    for (
      let depth = 0;
      depth < MAX_PARENT_HOPS && frontier.length > 0;
      depth += 1
    ) {
      const children = await repos.tasks.listSubtasksByParentIds(frontier);
      const nextFrontier: TaskPublicId[] = [];
      for (const child of children) {
        if (
          !collected.has(child.id) &&
          (child.projectId === null || child.projectId === projectId)
        ) {
          collected.set(child.id, child);
          nextFrontier.push(child.id);
        }
      }
      frontier = nextFrontier;
    }

    return Array.from(collected.values());
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
            project: toProjectDto(project, defaultStatuses),
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
        const visibleProjects: ProjectRecord[] = [];
        for (const project of allProjects) {
          const role = await resolveActorProjectRole(repos, actor.userId, project);
          if (canReadProject(role)) {
            visibleProjects.push(project);
          }
        }

        const namespaces = await repos.issueKeys.findNamespacesByProjectIds(
          visibleProjects.map((p) => p.id),
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
        for (const project of visibleProjects) {
          const statuses = await repos.statuses.listByProject(project.id);
          const ns = namespaceByProjectId.get(project.id) ?? null;
          const devSettings = ns
            ? toDevProjectSettingsDto(ns, prefixesByNamespaceId.get(ns.id) ?? [])
            : null;
          visible.push(toProjectDto(project, statuses, devSettings));
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
          const parentTask = await repos.tasks.findById(parentTaskId);
          if (!parentTask) {
            return fail(404, "NOT_FOUND", "error.notFound");
          }
          const parentResolved = await resolveTaskEffectiveProject(repos, parentTask);
          if (!parentResolved || parentResolved.project.id !== effectiveProject.id) {
            return fail(400, "VALIDATION_ERROR", "error.validation");
          }
          effectiveProject = parentResolved.project;
          parentDepth = parentResolved.depth;
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
      taskId: TaskPublicId,
    ): Promise<WorkUseCaseResult<TaskResponse>> {
      return deps.uow.run(async (repos) => {
        const task = await repos.tasks.findById(taskId);
        if (!task) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const resolved = await resolveTaskEffectiveProject(repos, task);
        if (!resolved) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const effectiveProject = resolved.project;

        const role = await resolveActorProjectRole(
          repos,
          actor.userId,
          effectiveProject,
        );
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

        const issueKey = await repos.issueKeys.findByTaskId(task.id);

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            task: toTaskDto(task, effectiveProject.id, issueKey),
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
        const issueKeysByTaskId = await repos.issueKeys.findByTaskIds(
          collectedTasks.map((t) => t.id),
        );

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            tasks: collectedTasks.map((t) =>
              toTaskDto(t, project.id, issueKeysByTaskId.get(t.id) ?? null),
            ),
          },
        };
      });
    },

    async updateTask(
      actor: AuditActorContext,
      taskId: TaskPublicId,
      patch: UpdateTaskRequest & Record<string, unknown>,
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
        const existing = await repos.tasks.findById(taskId);
        if (!existing) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const resolved = await resolveTaskEffectiveProject(repos, existing);
        if (!resolved) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const effectiveProject = resolved.project;

        const role = await resolveActorProjectRole(
          repos,
          actor.userId,
          effectiveProject,
        );
        if (!canWriteProjectTasks(role)) {
          await appendOutbox(repos, {
            workspaceId: effectiveProject.workspaceId,
            projectId: effectiveProject.id,
            eventType: "task.update.denied",
            action: "task.update",
            outcome: "denied",
            actor,
            targetType: "task",
            targetId: existing.id,
            reasonCode: "FORBIDDEN",
            payload: { taskId: existing.id, projectId: effectiveProject.id },
          });
          return fail(403, "FORBIDDEN", "error.forbidden");
        }

        if (patch.statusId !== undefined && patch.statusId !== null) {
          const status = await repos.statuses.findById(patch.statusId);
          if (!status || status.projectId !== effectiveProject.id) {
            return fail(400, "VALIDATION_ERROR", "error.validation");
          }
        }

        if (patch.assigneeId !== undefined && patch.assigneeId !== null) {
          const assigneeMembership = await repos.memberships.findByWorkspaceAndUser(
            effectiveProject.workspaceId,
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
          ...(patch.statusId !== undefined ? { statusId: patch.statusId } : {}),
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

        await appendOutbox(repos, {
          workspaceId: effectiveProject.workspaceId,
          projectId: effectiveProject.id,
          eventType: "task.updated",
          action: "task.update",
          outcome: "succeeded",
          actor,
          targetType: "task",
          targetId: updated.id,
          reasonCode: null,
          payload: {
            taskId: updated.id,
            projectId: effectiveProject.id,
            changes: {
              ...(patch.title !== undefined ? { title: updated.title } : {}),
              ...(patch.description !== undefined
                ? { description: updated.description }
                : {}),
              ...(patch.statusId !== undefined ? { statusId: updated.statusId } : {}),
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

        const issueKey = await repos.issueKeys.findByTaskId(updated.id);

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            task: toTaskDto(updated, effectiveProject.id, issueKey),
          },
        };
      });
    },

    async copyTask(
      actor: AuditActorContext,
      sourceTaskId: TaskPublicId,
      input: CopyTaskRequest & Record<string, unknown>,
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
        const sourceTask = await repos.tasks.findById(sourceTaskId);
        if (!sourceTask) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const sourceResolved = await resolveTaskEffectiveProject(repos, sourceTask);
        if (!sourceResolved) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const sourceRole = await resolveActorProjectRole(
          repos,
          actor.userId,
          sourceResolved.project,
        );
        if (!canReadProject(sourceRole)) {
          await appendOutbox(repos, {
            workspaceId: sourceResolved.project.workspaceId,
            projectId: sourceResolved.project.id,
            eventType: "task.copy.denied",
            action: "task.copy",
            outcome: "denied",
            actor,
            targetType: "task",
            targetId: sourceTask.id,
            reasonCode: "FORBIDDEN",
            payload: { taskId: sourceTask.id, projectId: sourceResolved.project.id },
          });
          return fail(404, "NOT_FOUND", "error.notFound");
        }

        let targetProject = sourceResolved.project;
        if (input.projectId !== undefined && input.projectId !== sourceResolved.project.id) {
          const requestedTarget = await repos.projects.findById(input.projectId);
          if (!requestedTarget) {
            return fail(404, "NOT_FOUND", "error.notFound");
          }
          if (requestedTarget.workspaceId !== sourceResolved.project.workspaceId) {
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
          const parentTask = await repos.tasks.findById(parentTaskId);
          if (!parentTask) {
            return fail(404, "NOT_FOUND", "error.notFound");
          }
          const parentResolved = await resolveTaskEffectiveProject(repos, parentTask);
          if (!parentResolved || parentResolved.project.id !== targetProject.id) {
            return fail(400, "VALIDATION_ERROR", "error.validation");
          }
          parentDepth = parentResolved.depth;
        }

        const storedProjectId =
          parentTaskId && input.inheritParentProject !== false
            ? null
            : targetProject.id;

        if (storedProjectId === null && parentDepth + 1 >= MAX_PARENT_HOPS) {
          return fail(400, "VALIDATION_ERROR", "error.validation");
        }

        let resolvedStatusId: StatusId | null = null;
        if (targetProject.id === sourceResolved.project.id) {
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
      taskId: TaskPublicId,
    ): Promise<WorkUseCaseResult<DeleteTaskResponse>> {
      return deps.uow.run(async (repos) => {
        const existing = await repos.tasks.findById(taskId);
        if (!existing) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const resolved = await resolveTaskEffectiveProject(repos, existing);
        if (!resolved) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const effectiveProject = resolved.project;
        const role = await resolveActorProjectRole(
          repos,
          actor.userId,
          effectiveProject,
        );
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
            dev: toDevProjectSettingsDto(updatedNamespace, allPrefixes),
            statuses: projectStatuses.map(toStatusDto),
          },
        };
      });
    },
  };
}
