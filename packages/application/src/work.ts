import { routeTaskEvent, parseRule, type RuleDefinition, type TaskField } from "./automation.js";
import {
  CONTRACT_VERSION,
  type ApiErrorCode,
  type CreateProjectRequest,
  type CreateTaskRequest,
  type OutboxEventDto,
  type ProjectDto,
  type ProjectListResponse,
  type ProjectResponse,
  type ProjectStatusDto,
  type TaskDto,
  type TaskListResponse,
  type TaskResponse,
  type UpdateTaskRequest,
} from "@prood/contracts";
import {
  canManageProject,
  canReadProject,
  canWriteProjectTasks,
  isValidEntityId,
  isValidProjectKind,
  isValidProjectVisibility,
  OUTBOX_SCHEMA_VERSION,
  resolveEffectiveProjectRole,
  type AuditActorContext,
  type EventChannel,
  type ProjectId,
  type ProjectRole,
  type TaskPublicId,
  type UserId,
  type WorkspaceId,
} from "@prood/domain";
import type { IdGenerator } from "./id.js";
import type { Clock } from "./index.js";
import type {
  OutboxEventRecord,
  ProjectRecord,
  ProjectStatusRecord,
  TaskRecord,
  TransactionRepositories,
  UnitOfWork,
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

function toStatusDto(record: ProjectStatusRecord): ProjectStatusDto {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    category: record.category,
    position: record.position,
  };
}

function toProjectDto(
  project: ProjectRecord,
  statuses: ProjectStatusRecord[],
): ProjectDto {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    kind: project.kind,
    visibility: project.visibility,
    name: project.name,
    description: project.description,
    statuses: statuses.map(toStatusDto),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function toTaskDto(
  task: TaskRecord,
  effectiveProjectId: ProjectId,
): TaskDto {
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    effectiveProjectId,
    parentTaskId: task.parentTaskId,
    statusId: task.statusId,
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
    const event = await repos.outbox.append({
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
        ...(params.actor.channel === "automation" && params.actor.parentRun
          ? { parentRun: params.actor.parentRun }
          : {}),
      },
      occurredAt: nowIso,
    });
    await routeTaskEvent(repos,event);
    return event;
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

  async function allowedValue(
    repos: TransactionRepositories,
    project: ProjectRecord,
    field: TaskField,
    value: string | null,
  ) {
    if (value === null) return true;
    if (field === "statusId")
      return (
        isValidEntityId("sts", value) &&
        (await repos.statuses.findById(value))?.projectId === project.id
      );
    return (
      isValidEntityId("usr", value) &&
      canReadProject(await resolveActorProjectRole(repos, value, project))
    );
  }
  async function visibleFilters(
    repos: TransactionRepositories,
    project: ProjectRecord,
    def: RuleDefinition,
  ) {
    const field = def.when === "status.changed" ? "statusId" : "assigneeId";
    for (const value of [def.from, def.to])
      if (value !== undefined && !(await allowedValue(repos, project, field, value)))
        return false;
    return true;
  }
  async function validCandidates(
    repos: TransactionRepositories,
    project: ProjectRecord,
    def: RuleDefinition,
  ) {
    return (
      (await visibleFilters(repos, project, def)) &&
      ((typeof def.action.value === "object" && def.action.value !== null) ||
        (await allowedValue(
          repos,
          project,
          def.action.field,
          def.action.value as string | null,
        )))
    );
  }

  return {
    async manageAutomation(
      actor: AuditActorContext,
      projectId: ProjectId,
      rule: string,
      command: Record<string, unknown>,
    ): Promise<
      WorkUseCaseResult<{
        rule: string;
        revision: number;
        project: ProjectId;
        delegate: UserId;
        delegateName: string;
        projectName: string;
        labels: Record<string, string>;
        enabled: boolean;
        definition: RuleDefinition;
      }>
    > {
      return deps.uow.run(async (repos) => {
        const project = await repos.projects.findById(projectId);
        if (
          !project ||
          !actor.userId ||
          !canManageProject(await resolveActorProjectRole(repos, actor.userId, project))
        )
          return fail(404, "NOT_FOUND", "error.notFound");
        const op = command.op;
        if (
          !/^[A-Za-z0-9_-]{1,80}$/.test(rule) ||
          typeof op !== "string" ||
          !["preview", "publish", "stop"].includes(op) ||
          Object.keys(command).some(
            (k) => !["op", "revision", "definition", "delegate"].includes(k),
          )
        )
          return fail(400, "VALIDATION_ERROR", "error.validation");
        const prior = (await repos.automation.rules(projectId)).find((r) => r.rule === rule);
        const expected = prior?.revision ?? 0;
        if (command.revision !== expected) return fail(409, "CONFLICT", "error.conflict");
        const stop = op === "stop";
        if (stop && !prior) return fail(404, "NOT_FOUND", "error.notFound");
        const definition = stop ? prior!.definition : parseRule(command.definition);
        if (
          !definition ||
          (!stop &&
            (command.delegate !== actor.userId ||
              !(await validCandidates(repos, project, definition))))
        )
          return fail(400, "VALIDATION_ERROR", "error.validation");
        const delegate = stop ? prior!.actor : actor.userId;
        const visibleDelegate =
          !stop || canReadProject(await resolveActorProjectRole(repos, delegate, project));
        const delegateName = visibleDelegate
          ? ((await repos.users.findById(delegate))?.displayName ?? delegate)
          : delegate;
        const labels: Record<string, string> = {};
        if (!stop)
          for (const id of [definition.from, definition.to, definition.action.value]) {
            if (typeof id !== "string") continue;
            if (isValidEntityId("usr", id))
              labels[id] = (await repos.users.findById(id))?.displayName ?? id;
            if (isValidEntityId("sts", id))
              labels[id] = (await repos.statuses.findById(id))?.name ?? id;
          }
        const data = {
          project: projectId,
          projectName: project.name,
          labels,
          rule,
          revision: expected + 1,
          delegate,
          delegateName,
          definition,
          enabled: !stop,
        };
        if (op !== "preview") {
          if (
            !(await repos.automation.save(
              {
                ...data,
                actor: delegate,
                delegation:
                  !prior || !prior.enabled || stop || prior.actor !== delegate
                    ? data.revision
                    : prior.delegation,
              },
              expected,
            ))
          )
            return fail(409, "CONFLICT", "error.conflict");
          await appendOutbox(repos, {
            workspaceId: project.workspaceId,
            projectId,
            eventType: "automation.rule." + op,
            action: "automation." + op,
            outcome: "succeeded",
            actor,
            targetType: "rule",
            targetId: rule,
            reasonCode: null,
            payload: { delegate, revision: data.revision, enabled: data.enabled },
          });
        }
        return { ok: true, data };
      });
    },

    async manualAutomation(
      actor: AuditActorContext,
      projectId: ProjectId,
      rule: string,
      id: TaskPublicId,
    ): Promise<WorkUseCaseResult<{ event: string }>> {
      return deps.uow.run(async (repos) => {
        const task = await repos.tasks.findById(id, true);
        const resolved = task && (await resolveTaskEffectiveProject(repos, task));
        if (
          !task ||
          !resolved ||
          resolved.project.id !== projectId ||
          !canWriteProjectTasks(
            await resolveActorProjectRole(repos, actor.userId, resolved.project),
          )
        )
          return fail(404, "NOT_FOUND", "error.notFound");
        const sub = (await repos.automation.rules(projectId)).find(
          (r) => r.rule === rule && r.enabled && r.definition.when === "manual",
        );
        if (!sub) return fail(404, "NOT_FOUND", "error.notFound");
        const e = await appendOutbox(repos, {
          workspaceId: task.workspaceId,
          projectId,
          eventType: "task.manual",
          action: "automation.start",
          outcome: "succeeded",
          actor,
          targetType: "task",
          targetId: id,
          reasonCode: null,
          payload: {
            rule,
            taskVersion: task.version,
            statusId: task.statusId,
            assigneeId: task.assigneeId,
          },
        });
        return { ok: true, data: { event: e.eventId } };
      });
    },

    // Internal worker port; the queue's stored intent is authoritative. Stage 8.2 only prepares changes.
    async prepareAutomation(
      workspace: WorkspaceId,
      event: string,
      rule: string,
      run: string,
      projectId: ProjectId,
      revision: number,
    ) {
      return deps.uow.run(async (repos) => {
        const d = await repos.automation.intent(workspace, event, rule);
        if (!d || d.project !== projectId || d.revision !== revision)
          return { status: "denied" } as const;
        const p = d.proposal;
        const task = await repos.tasks.findById(p.task, true);
        const resolved = task && (await resolveTaskEffectiveProject(repos, task));
        const sub = (await repos.automation.rules(d.project)).find((r) => r.rule === rule);
        const field = p.definition.action.field;
        const ref = p.definition.action.value;
        const value = ref !== null && typeof ref === "object" ? p.fields[ref.event] : ref;
        const authorized = !!(
          task &&
          resolved &&
          task.workspaceId === workspace &&
          resolved.project.id === d.project &&
          sub?.enabled &&
          sub.delegation === p.delegation &&
          sub.actor === p.delegate &&
          canWriteProjectTasks(
            await resolveActorProjectRole(repos, p.delegate, resolved.project),
          ) &&
          (await visibleFilters(repos, resolved.project, p.definition)) &&
          (await allowedValue(repos, resolved.project, field, value))
        );
        const status = !authorized
          ? "denied"
          : task!.version !== p.version ||
              (p.definition.ifUnassigned && task!.assigneeId !== null)
            ? "skipped"
            : "prepared";
        if (await repos.automation.firstCheck(d, run, status))
          await appendOutbox(repos, {
            workspaceId: workspace,
            projectId: d.project,
            eventType: "automation." + status,
            action: "automation.prepare",
            outcome: authorized ? "succeeded" : "denied",
            actor: { userId: p.delegate, actorType: "user", channel: "automation" },
            targetType: "rule",
            targetId: rule,
            reasonCode: status === "prepared" ? null : status,
            payload: {
              origin: p.origin,
              delegate: p.delegate,
              rule,
              revision: d.revision,
              run,
              cause: event,
              ...(authorized && { taskId: p.task, field }),
            },
          });
        return status === "prepared"
          ? ({ status, field, value } as const)
          : ({ status } as const);
      });
    },

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
        const visible: ProjectDto[] = [];
        for (const project of allProjects) {
          const role = await resolveActorProjectRole(repos, actor.userId, project);
          if (!canReadProject(role)) {
            continue;
          }
          const statuses = await repos.statuses.listByProject(project.id);
          visible.push(toProjectDto(project, statuses));
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
      if (actor.channel === "automation") return fail(403, "FORBIDDEN", "error.forbidden");
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
        (typeof input.statusId !== "string" || !isValidEntityId("sts", input.statusId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        input.assigneeId !== undefined &&
        input.assigneeId !== null &&
        (typeof input.assigneeId !== "string" || !isValidEntityId("usr", input.assigneeId))
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

      const description = typeof input.description === "string" ? input.description : "";

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
          parentTaskId && input.inheritParentProject !== false ? null : effectiveProject.id;

        if (storedProjectId === null && parentDepth + 1 >= MAX_PARENT_HOPS) {
          return fail(400, "VALIDATION_ERROR", "error.validation");
        }

        const role = await resolveActorProjectRole(repos, actor.userId, effectiveProject);
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
          const projectStatuses = await repos.statuses.listByProject(effectiveProject.id);
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

        const nowIso = deps.clock.now().toISOString();
        const taskId = deps.idGenerator.next("tsk");
        const task = await repos.tasks.create({
          id: taskId,
          workspaceId: effectiveProject.workspaceId,
          projectId: storedProjectId,
          parentTaskId,
          statusId: resolvedStatusId,
          title,
          description,
          assigneeId,
          createdBy: actor.userId,
          dueOn: input.dueOn ?? null,
          position: 0,
          createdAt: nowIso,
        });

        await appendOutbox(repos, {
          workspaceId: effectiveProject.workspaceId,
          projectId: effectiveProject.id,
          eventType: "task.created",
          action: "task.create",
          outcome: "succeeded",
          actor,
          targetType: "task",
          targetId: task.id,
          reasonCode: null,
          payload: {
            taskId: task.id,
            taskVersion: task.version,
            projectId: effectiveProject.id,
            projectKind: effectiveProject.kind,
            parentTaskId: task.parentTaskId,
            title: task.title,
            statusId: task.statusId,
            assigneeId: task.assigneeId,
          },
        });

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            task: toTaskDto(task, effectiveProject.id),
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

        const role = await resolveActorProjectRole(repos, actor.userId, effectiveProject);
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

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            task: toTaskDto(task, effectiveProject.id),
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

        const directTasks = await repos.tasks.listByProject(project.id);
        const collected = new Map<TaskPublicId, TaskRecord>();
        let frontier: TaskPublicId[] = [];
        for (const task of directTasks) {
          collected.set(task.id, task);
          frontier.push(task.id);
        }

        for (let depth = 0; depth < MAX_PARENT_HOPS && frontier.length > 0; depth += 1) {
          const children = await repos.tasks.listSubtasksByParentIds(frontier);
          const nextFrontier: TaskPublicId[] = [];
          for (const child of children) {
            if (
              !collected.has(child.id) &&
              (child.projectId === null || child.projectId === project.id)
            ) {
              collected.set(child.id, child);
              nextFrontier.push(child.id);
            }
          }
          frontier = nextFrontier;
        }

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            tasks: Array.from(collected.values()).map((t) => toTaskDto(t, project.id)),
          },
        };
      });
    },

    async updateTask(
      actor: AuditActorContext,
      taskId: TaskPublicId,
      patch: UpdateTaskRequest & Record<string, unknown>,
    ): Promise<WorkUseCaseResult<TaskResponse>> {
      if (actor.channel === "automation") return fail(403, "FORBIDDEN", "error.forbidden");
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
        (typeof patch.statusId !== "string" || !isValidEntityId("sts", patch.statusId))
      ) {
        return fail(400, "VALIDATION_ERROR", "error.validation");
      }
      if (
        patch.assigneeId !== undefined &&
        patch.assigneeId !== null &&
        (typeof patch.assigneeId !== "string" || !isValidEntityId("usr", patch.assigneeId))
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
        const existing = await repos.tasks.findById(taskId, true);
        if (!existing) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const resolved = await resolveTaskEffectiveProject(repos, existing);
        if (!resolved) {
          return fail(404, "NOT_FOUND", "error.notFound");
        }
        const effectiveProject = resolved.project;

        const role = await resolveActorProjectRole(repos, actor.userId, effectiveProject);
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
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.statusId !== undefined ? { statusId: patch.statusId } : {}),
          ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
          ...(patch.dueOn !== undefined ? { dueOn: patch.dueOn } : {}),
          ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
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
            taskVersion: updated.version,
            before: { statusId: existing.statusId, assigneeId: existing.assigneeId },
            after: { statusId: updated.statusId, assigneeId: updated.assigneeId },
            projectId: effectiveProject.id,
            changes: {
              ...(patch.title !== undefined ? { title: updated.title } : {}),
              ...(patch.description !== undefined
                ? { description: updated.description }
                : {}),
              ...(patch.statusId !== undefined ? { statusId: updated.statusId } : {}),
              ...(patch.assigneeId !== undefined ? { assigneeId: updated.assigneeId } : {}),
              ...(patch.dueOn !== undefined ? { dueOn: updated.dueOn } : {}),
              ...(patch.completedAt !== undefined
                ? { completedAt: updated.completedAt }
                : {}),
            },
          },
        });

        return {
          ok: true,
          data: {
            contractVersion: CONTRACT_VERSION,
            task: toTaskDto(updated, effectiveProject.id),
          },
        };
      });
    },
  };
}
