import { sql, type Kysely, type Transaction } from "kysely";
import type {
  AppendOutboxEventInput,
  AuthIdentityRecord,
  CreateMembershipInput,
  CreateProjectInput,
  CreateProjectStatusInput,
  CreateTaskInput,
  CreateUserInput,
  CreateWorkspaceInput,
  LinkAuthIdentityInput,
  OutboxEventRecord,
  OutboxRepository,
  ProjectMembershipRecord,
  ProjectRecord,
  ProjectRepository,
  ProjectStatusRecord,
  ProjectStatusRepository,
  TaskRecord,
  TaskRepository,
  TransactionRepositories,
  UpdateTaskInput,
  UpsertProjectMembershipInput,
  UpsertWorkspaceSettingsInput,
  UserRecord,
  UserRepository,
  WorkspaceMembershipRecord,
  WorkspaceMembershipRepository,
  WorkspaceRecord,
  WorkspaceRepository,
  WorkspaceSettingsRecord,
  WorkspaceSettingsRepository,
} from "@prood/application";
import type { WorkspaceMembershipSummary } from "@prood/contracts";
import {
  normalizeEmail,
  type ActorType,
  type EventChannel,
  type EventId,
  type EventOutcome,
  type LocaleCode,
  type MembershipId,
  type OutboxId,
  type ProjectId,
  type ProjectKind,
  type ProjectRole,
  type ProjectVisibility,
  type StatusCategory,
  type StatusId,
  type TaskPublicId,
  type UserId,
  type WorkspaceId,
  type WorkspaceRole,
} from "@prood/domain";
import type {
  AuthIdentityTable,
  OutboxEventTable,
  ProodDatabase,
  ProjectMembershipTable,
  ProjectStatusTable,
  ProjectTable,
  TaskTable,
  UserTable,
  WorkspaceMembershipTable,
  WorkspaceSettingsTable,
  WorkspaceTable,
} from "./schema.js";

type DbExecutor = Kysely<ProodDatabase> | Transaction<ProodDatabase>;

function toWorkspaceRecord(row: WorkspaceTable): WorkspaceRecord {
  return {
    id: row.id as WorkspaceId,
    slug: row.slug,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWorkspaceSettingsRecord(
  row: WorkspaceSettingsTable,
): WorkspaceSettingsRecord {
  return {
    workspaceId: row.workspace_id as WorkspaceId,
    defaultLocale: row.default_locale as LocaleCode,
    devProjectsEnabled: Number(row.dev_projects_enabled) === 1,
    updatedAt: row.updated_at,
  };
}

function toUserRecord(row: UserTable): UserRecord {
  return {
    id: row.id as UserId,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAuthIdentityRecord(row: AuthIdentityTable): AuthIdentityRecord {
  return {
    authProvider: row.auth_provider,
    authSubject: row.auth_subject,
    userId: row.user_id as UserId,
    createdAt: row.created_at,
  };
}

function toWorkspaceMembershipRecord(
  row: WorkspaceMembershipTable,
): WorkspaceMembershipRecord {
  return {
    id: row.id as MembershipId,
    workspaceId: row.workspace_id as WorkspaceId,
    userId: row.user_id as UserId,
    role: row.role as WorkspaceRole,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProjectRecord(row: ProjectTable): ProjectRecord {
  return {
    id: row.id as ProjectId,
    workspaceId: row.workspace_id as WorkspaceId,
    kind: row.kind as ProjectKind,
    visibility: row.visibility as ProjectVisibility,
    name: row.name,
    description: row.description,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProjectMembershipRecord(
  row: ProjectMembershipTable,
): ProjectMembershipRecord {
  return {
    id: row.id as MembershipId,
    projectId: row.project_id as ProjectId,
    userId: row.user_id as UserId,
    role: row.role as ProjectRole,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProjectStatusRecord(row: ProjectStatusTable): ProjectStatusRecord {
  return {
    id: row.id as StatusId,
    workspaceId: row.workspace_id as WorkspaceId,
    projectId: row.project_id as ProjectId,
    name: row.name,
    category: row.category as StatusCategory,
    position: Number(row.position),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTaskRecord(row: import("kysely").Selectable<TaskTable>): TaskRecord {
  return {
    version: Number(row.version),
    id: row.id as TaskPublicId,
    workspaceId: row.workspace_id as WorkspaceId,
    projectId: row.project_id as ProjectId | null,
    parentTaskId: row.parent_task_id as TaskPublicId | null,
    statusId: row.status_id as StatusId | null,
    title: row.title,
    description: row.description,
    assigneeId: row.assignee_id as UserId | null,
    createdBy: row.created_by as UserId | null,
    dueOn: row.due_on,
    completedAt: row.completed_at,
    position: Number(row.position),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOutboxEventRecord(row: OutboxEventTable): OutboxEventRecord {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }
  return {
    id: row.id as OutboxId,
    eventId: row.event_id as EventId,
    schemaVersion: Number(row.schema_version),
    workspaceId: row.workspace_id as WorkspaceId | null,
    projectId: row.project_id as ProjectId | null,
    eventType: row.event_type,
    action: row.action,
    outcome: row.outcome as EventOutcome,
    actorUserId: row.actor_user_id as UserId | null,
    actorType: row.actor_type as ActorType,
    channel: row.channel as EventChannel,
    targetType: row.target_type,
    targetId: row.target_id,
    reasonCode: row.reason_code,
    payload,
    occurredAt: row.occurred_at,
    deliveryStatus: row.delivery_status as OutboxEventRecord["deliveryStatus"],
    attempts: Number(row.attempts),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

async function runQuery<T>(
  fn: () => Promise<T>,
  mapError: (error: unknown) => never,
  assertActive?: () => void,
): Promise<T> {
  assertActive?.();
  try {
    return await fn();
  } catch (error) {
    return mapError(error);
  }
}

/**
 * Builds Kysely-backed repositories bound to a single transaction or executor.
 */
export function createKyselyRepositories(
  executor: DbExecutor,
  mapError: (error: unknown) => never,
  assertActive?: () => void,
  postgres = false,
): TransactionRepositories {
  const workspaces: WorkspaceRepository = {
    async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
      const slug = normalizeSlug(input.slug);
      const row = await runQuery(
        () =>
          executor
            .insertInto("workspaces")
            .values({
              id: input.id,
              slug,
              name: input.name,
              created_at: input.createdAt,
              updated_at: input.createdAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        mapError,
        assertActive,
      );
      return toWorkspaceRecord(row);
    },

    async findById(id: WorkspaceId): Promise<WorkspaceRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("workspaces")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toWorkspaceRecord(row) : null;
    },

    async findBySlug(slug: string): Promise<WorkspaceRecord | null> {
      const normalized = normalizeSlug(slug);
      const row = await runQuery(
        () =>
          executor
            .selectFrom("workspaces")
            .selectAll()
            .where((eb) => eb(eb.fn<string>("lower", ["slug"]), "=", normalized))
            .orderBy("id", "asc")
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toWorkspaceRecord(row) : null;
    },

    async updateName(
      id: WorkspaceId,
      name: string,
      updatedAt: string,
    ): Promise<WorkspaceRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .updateTable("workspaces")
            .set({ name, updated_at: updatedAt })
            .where("id", "=", id)
            .returningAll()
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toWorkspaceRecord(row) : null;
    },
  };

  const workspaceSettings: WorkspaceSettingsRepository = {
    async upsert(
      input: UpsertWorkspaceSettingsInput,
    ): Promise<WorkspaceSettingsRecord> {
      const enabledInt = input.devProjectsEnabled ? 1 : 0;
      const row = await runQuery(
        () =>
          executor
            .insertInto("workspace_settings")
            .values({
              workspace_id: input.workspaceId,
              default_locale: input.defaultLocale,
              dev_projects_enabled: enabledInt,
              updated_at: input.updatedAt,
            })
            .onConflict((oc) =>
              oc.column("workspace_id").doUpdateSet({
                default_locale: input.defaultLocale,
                dev_projects_enabled: enabledInt,
                updated_at: input.updatedAt,
              }),
            )
            .returningAll()
            .executeTakeFirstOrThrow(),
        mapError,
        assertActive,
      );
      return toWorkspaceSettingsRecord(row);
    },

    async findByWorkspaceId(
      workspaceId: WorkspaceId,
    ): Promise<WorkspaceSettingsRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("workspace_settings")
            .selectAll()
            .where("workspace_id", "=", workspaceId)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toWorkspaceSettingsRecord(row) : null;
    },
  };

  const users: UserRepository = {
    async findById(id: UserId): Promise<UserRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("users")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toUserRecord(row) : null;
    },

    async findByEmail(email: string): Promise<UserRecord | null> {
      const normalized = normalizeEmail(email);
      const row = await runQuery(
        () =>
          executor
            .selectFrom("users")
            .selectAll()
            .where((eb) => eb(eb.fn<string>("lower", ["email"]), "=", normalized))
            .orderBy("id", "asc")
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toUserRecord(row) : null;
    },

    async findByAuthIdentity(
      authProvider: string,
      authSubject: string,
    ): Promise<UserRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("auth_identities")
            .innerJoin("users", "users.id", "auth_identities.user_id")
            .select([
              "users.id",
              "users.email",
              "users.display_name",
              "users.created_at",
              "users.updated_at",
            ])
            .where("auth_identities.auth_provider", "=", authProvider)
            .where("auth_identities.auth_subject", "=", authSubject)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toUserRecord(row) : null;
    },

    async create(input: CreateUserInput): Promise<UserRecord> {
      const email = normalizeEmail(input.email);
      const row = await runQuery(
        () =>
          executor
            .insertInto("users")
            .values({
              id: input.id,
              email,
              display_name: input.displayName,
              created_at: input.createdAt,
              updated_at: input.createdAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        mapError,
        assertActive,
      );
      return toUserRecord(row);
    },

    async linkAuthIdentity(
      input: LinkAuthIdentityInput,
    ): Promise<AuthIdentityRecord> {
      const row = await runQuery(
        () =>
          executor
            .insertInto("auth_identities")
            .values({
              auth_provider: input.authProvider,
              auth_subject: input.authSubject,
              user_id: input.userId,
              created_at: input.createdAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        mapError,
        assertActive,
      );
      return toAuthIdentityRecord(row);
    },
  };

  const memberships: WorkspaceMembershipRepository = {
    async create(
      input: CreateMembershipInput,
    ): Promise<WorkspaceMembershipRecord> {
      const row = await runQuery(
        () =>
          executor
            .insertInto("workspace_memberships")
            .values({
              id: input.id,
              workspace_id: input.workspaceId,
              user_id: input.userId,
              role: input.role,
              created_at: input.createdAt,
              updated_at: input.createdAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        mapError,
        assertActive,
      );
      return toWorkspaceMembershipRecord(row);
    },

    async findByWorkspaceAndUser(
      workspaceId: WorkspaceId,
      userId: UserId,
    ): Promise<WorkspaceMembershipRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("workspace_memberships")
            .selectAll()
            .where("workspace_id", "=", workspaceId)
            .where("user_id", "=", userId)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toWorkspaceMembershipRecord(row) : null;
    },

    async listSummariesForUser(
      userId: UserId,
    ): Promise<WorkspaceMembershipSummary[]> {
      const rows = await runQuery(
        () =>
          executor
            .selectFrom("workspace_memberships")
            .innerJoin(
              "workspaces",
              "workspaces.id",
              "workspace_memberships.workspace_id",
            )
            .select([
              "workspace_memberships.id as membership_id",
              "workspaces.id as workspace_id",
              "workspaces.slug as workspace_slug",
              "workspaces.name as workspace_name",
              "workspace_memberships.role as role",
            ])
            .where("workspace_memberships.user_id", "=", userId)
            .orderBy("workspaces.created_at", "asc")
            .orderBy("workspaces.id", "asc")
            .execute(),
        mapError,
        assertActive,
      );

      return rows.map((row) => ({
        membershipId: row.membership_id as MembershipId,
        workspaceId: row.workspace_id as WorkspaceId,
        workspaceSlug: row.workspace_slug,
        workspaceName: row.workspace_name,
        role: row.role as WorkspaceRole,
      }));
    },
  };

  const projects: ProjectRepository = {
    async create(input: CreateProjectInput): Promise<ProjectRecord> {
      const row = await runQuery(
        () =>
          executor
            .insertInto("projects")
            .values({
              id: input.id,
              workspace_id: input.workspaceId,
              kind: input.kind,
              visibility: input.visibility,
              name: input.name,
              description: input.description,
              archived_at: null,
              created_at: input.createdAt,
              updated_at: input.createdAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        mapError,
        assertActive,
      );
      return toProjectRecord(row);
    },

    async findById(id: ProjectId): Promise<ProjectRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("projects")
            .selectAll()
            .where("id", "=", id)
            .where("archived_at", "is", null)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toProjectRecord(row) : null;
    },

    async listByWorkspace(workspaceId: WorkspaceId): Promise<ProjectRecord[]> {
      const rows = await runQuery(
        () =>
          executor
            .selectFrom("projects")
            .selectAll()
            .where("workspace_id", "=", workspaceId)
            .where("archived_at", "is", null)
            .orderBy("created_at", "asc")
            .orderBy("id", "asc")
            .execute(),
        mapError,
        assertActive,
      );
      return rows.map(toProjectRecord);
    },

    async upsertMembership(
      input: UpsertProjectMembershipInput,
    ): Promise<ProjectMembershipRecord> {
      const row = await runQuery(
        () =>
          executor
            .insertInto("project_memberships")
            .values({
              id: input.id,
              project_id: input.projectId,
              user_id: input.userId,
              role: input.role,
              created_at: input.createdAt,
              updated_at: input.createdAt,
            })
            .onConflict((oc) =>
              oc.columns(["project_id", "user_id"]).doUpdateSet({
                role: input.role,
                updated_at: input.createdAt,
              }),
            )
            .returningAll()
            .executeTakeFirstOrThrow(),
        mapError,
        assertActive,
      );
      return toProjectMembershipRecord(row);
    },

    async findMembership(
      projectId: ProjectId,
      userId: UserId,
    ): Promise<ProjectMembershipRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("project_memberships")
            .selectAll()
            .where("project_id", "=", projectId)
            .where("user_id", "=", userId)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toProjectMembershipRecord(row) : null;
    },
  };

  const statuses: ProjectStatusRepository = {
    async create(input: CreateProjectStatusInput): Promise<ProjectStatusRecord> {
      const row = await runQuery(
        () =>
          executor
            .insertInto("project_statuses")
            .values({
              id: input.id,
              workspace_id: input.workspaceId,
              project_id: input.projectId,
              name: input.name,
              category: input.category,
              position: input.position,
              created_at: input.createdAt,
              updated_at: input.createdAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        mapError,
        assertActive,
      );
      return toProjectStatusRecord(row);
    },

    async findById(id: StatusId): Promise<ProjectStatusRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("project_statuses")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toProjectStatusRecord(row) : null;
    },

    async listByProject(projectId: ProjectId): Promise<ProjectStatusRecord[]> {
      const rows = await runQuery(
        () =>
          executor
            .selectFrom("project_statuses")
            .selectAll()
            .where("project_id", "=", projectId)
            .orderBy("position", "asc")
            .orderBy("id", "asc")
            .execute(),
        mapError,
        assertActive,
      );
      return rows.map(toProjectStatusRecord);
    },
  };

  const tasks: TaskRepository = {
    async create(input: CreateTaskInput): Promise<TaskRecord> {
      const row = await runQuery(
        () =>
          executor
            .insertInto("tasks")
            .values({
              version: 1,
              id: input.id,
              workspace_id: input.workspaceId,
              project_id: input.projectId,
              parent_task_id: input.parentTaskId,
              status_id: input.statusId,
              title: input.title,
              description: input.description,
              assignee_id: input.assigneeId,
              created_by: input.createdBy,
              due_on: input.dueOn,
              completed_at: null,
              position: input.position,
              created_at: input.createdAt,
              updated_at: input.createdAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        mapError,
        assertActive,
      );
      return toTaskRecord(row);
    },

    async findById(id: TaskPublicId, forUpdate=false): Promise<TaskRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("tasks")
            .selectAll()
            .where("id", "=", id)
            .$if(postgres && forUpdate, q=>q.forUpdate())
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toTaskRecord(row) : null;
    },

    async listByProject(projectId: ProjectId): Promise<TaskRecord[]> {
      const rows = await runQuery(
        () =>
          executor
            .selectFrom("tasks")
            .selectAll()
            .where("project_id", "=", projectId)
            .orderBy("position", "asc")
            .orderBy("created_at", "asc")
            .orderBy("id", "asc")
            .execute(),
        mapError,
        assertActive,
      );
      return rows.map(toTaskRecord);
    },

    async listSubtasks(parentTaskId: TaskPublicId): Promise<TaskRecord[]> {
      const rows = await runQuery(
        () =>
          executor
            .selectFrom("tasks")
            .selectAll()
            .where("parent_task_id", "=", parentTaskId)
            .orderBy("position", "asc")
            .orderBy("created_at", "asc")
            .orderBy("id", "asc")
            .execute(),
        mapError,
        assertActive,
      );
      return rows.map(toTaskRecord);
    },

    async listSubtasksByParentIds(
      parentTaskIds: readonly TaskPublicId[],
    ): Promise<TaskRecord[]> {
      const uniqueIds = Array.from(new Set(parentTaskIds));
      if (uniqueIds.length === 0) {
        return [];
      }

      // Keep each IN clause comfortably below SQLite's bind-parameter limit (999).
      const SUBTASK_PARENT_BATCH_SIZE = 200;
      const results: TaskRecord[] = [];
      let chunkCount = 0;

      for (let i = 0; i < uniqueIds.length; i += SUBTASK_PARENT_BATCH_SIZE) {
        const chunk = uniqueIds.slice(i, i + SUBTASK_PARENT_BATCH_SIZE);
        chunkCount += 1;
        const rows = await runQuery(
          () =>
            executor
              .selectFrom("tasks")
              .selectAll()
              .where("parent_task_id", "in", chunk)
              .orderBy("position", "asc")
              .orderBy("created_at", "asc")
              .orderBy("id", "asc")
              .execute(),
          mapError,
          assertActive,
        );
        for (const row of rows) {
          results.push(toTaskRecord(row));
        }
      }

      if (chunkCount > 1) {
        results.sort((a, b) => {
          if (a.position !== b.position) {
            return a.position - b.position;
          }
          if (a.createdAt !== b.createdAt) {
            return a.createdAt < b.createdAt ? -1 : 1;
          }
          if (a.id !== b.id) {
            return a.id < b.id ? -1 : 1;
          }
          return 0;
        });
      }

      return results;
    },

    async update(
      id: TaskPublicId,
      input: UpdateTaskInput,
    ): Promise<TaskRecord | null> {
      const patch: Record<string, unknown> = {
        updated_at: input.updatedAt,
      };
      if (input.title !== undefined) {
        patch.title = input.title;
      }
      if (input.description !== undefined) {
        patch.description = input.description;
      }
      if (input.statusId !== undefined) {
        patch.status_id = input.statusId;
      }
      if (input.assigneeId !== undefined) {
        patch.assignee_id = input.assigneeId;
      }
      if (input.dueOn !== undefined) {
        patch.due_on = input.dueOn;
      }
      if (input.completedAt !== undefined) {
        patch.completed_at = input.completedAt;
      }
      const row = await runQuery(
        () =>
          executor
            .updateTable("tasks")
            .set({...patch,version:sql<number>`version + 1`})
            .where("id", "=", id)
            .returningAll()
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toTaskRecord(row) : null;
    },
  };

  const outbox: OutboxRepository = {
    async append(input: AppendOutboxEventInput): Promise<OutboxEventRecord> {
      const row = await runQuery(
        () =>
          executor
            .insertInto("outbox_events")
            .values({
              id: input.id,
              event_id: input.eventId,
              schema_version: input.schemaVersion,
              workspace_id: input.workspaceId,
              project_id: input.projectId,
              event_type: input.eventType,
              action: input.action,
              outcome: input.outcome,
              actor_user_id: input.actorUserId,
              actor_type: input.actorType,
              channel: input.channel,
              target_type: input.targetType,
              target_id: input.targetId,
              reason_code: input.reasonCode,
              payload_json: JSON.stringify(input.payload),
              occurred_at: input.occurredAt,
              delivery_status: "pending",
              attempts: 0,
              lease_owner: null,
              lease_expires_at: null,
              next_attempt_at: input.occurredAt,
              delivered_at: null,
              last_error: null,
              created_at: input.occurredAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        mapError,
        assertActive,
      );
      return toOutboxEventRecord(row);
    },

    async listByWorkspace(
      workspaceId: WorkspaceId,
    ): Promise<OutboxEventRecord[]> {
      const rows = await runQuery(
        () =>
          executor
            .selectFrom("outbox_events")
            .selectAll()
            .where("workspace_id", "=", workspaceId)
            .orderBy("occurred_at", "asc")
            .orderBy("id", "asc")
            .execute(),
        mapError,
        assertActive,
      );
      return rows.map(toOutboxEventRecord);
    },

    async listAll(): Promise<OutboxEventRecord[]> {
      const rows = await runQuery(
        () =>
          executor
            .selectFrom("outbox_events")
            .selectAll()
            .orderBy("occurred_at", "asc")
            .orderBy("id", "asc")
            .execute(),
        mapError,
        assertActive,
      );
      return rows.map(toOutboxEventRecord);
    },
  };

  const automation: TransactionRepositories["automation"] = {
    async rules(project) {
      const rows = await runQuery(
        () =>
          executor
            .selectFrom("automation_rules")
            .selectAll()
            .where("project", "=", project)
            .orderBy("rule")
            .execute(),
        mapError,
        assertActive,
      );
      return rows.map((r) => ({
        project,
        rule: r.rule,
        revision: r.revision,
        delegation: r.delegation,
        actor: r.actor as UserId,
        enabled: !!r.enabled,
        definition: JSON.parse(r.definition),
      }));
    },
    async save(rule, expected) {
      const values = {
        revision: rule.revision,
        delegation: rule.delegation,
        actor: rule.actor,
        enabled: Number(rule.enabled),
        definition: JSON.stringify(rule.definition),
      };
      if (!expected) {
        const row = await runQuery(
          () =>
            executor
              .insertInto("automation_rules")
              .values({ ...values, project: rule.project, rule: rule.rule })
              .onConflict((c) => c.columns(["project", "rule"]).doNothing())
              .returning("rule")
              .executeTakeFirst(),
          mapError,
          assertActive,
        );
        return !!row;
      }
      const row = await runQuery(
        () =>
          executor
            .updateTable("automation_rules")
            .set(values)
            .where("project", "=", rule.project)
            .where("rule", "=", rule.rule)
            .where("revision", "=", expected)
            .returning("rule")
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return !!row;
    },
    async enqueue(d, reason) {
      await runQuery(
        () =>
          executor
            .insertInto("automation_deliveries")
            .values({
              workspace: d.organization,
              project: d.project,
              rule: d.rule,
              event: d.event,
              envelope: JSON.stringify(d),
              reason,
              run: null,
              token: null,
              expires: null,
            })
            .execute(),
        mapError,
        assertActive,
      );
    },
    async claim(workspace, token, now, expires) {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("automation_deliveries")
            .selectAll()
            .where("workspace", "=", workspace)
            .where("run", "is", null)
            .where("reason", "is", null)
            .where((eb) => eb.or([eb("expires", "is", null), eb("expires", "<=", now)]))
            .orderBy("event")
            .orderBy("rule")
            .limit(1)
            .$if(postgres, (q) => q.forUpdate().skipLocked())
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      if (!row) return null;
      await runQuery(
        () =>
          executor
            .updateTable("automation_deliveries")
            .set({ token, expires })
            .where("event", "=", row.event)
            .where("rule", "=", row.rule)
            .execute(),
        mapError,
        assertActive,
      );
      return JSON.parse(row.envelope);
    },
    async confirm(d, token, run, now) {
      const row = await runQuery(
        () =>
          executor
            .updateTable("automation_deliveries")
            .set({ run, token: null, expires: null })
            .where("workspace", "=", d.organization)
            .where("event", "=", d.event)
            .where("rule", "=", d.rule)
            .where("token", "=", token)
            .where("expires", ">", now)
            .returning("run")
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return !!row;
    },
    async firstCheck(d, run, status) {
      return !!(await runQuery(
        () =>
          executor
            .insertInto("automation_checks")
            .values({ event: d.event, rule: d.rule, run, status })
            .onConflict((c) => c.columns(["event", "rule", "run", "status"]).doNothing())
            .returning("event")
            .executeTakeFirst(),
        mapError,
        assertActive,
      ));
    },
    async intent(workspace, event, rule) {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("automation_deliveries")
            .select("envelope")
            .where("workspace", "=", workspace)
            .where("event", "=", event)
            .where("rule", "=", rule)
            .where("reason", "is", null)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? JSON.parse(row.envelope) : null;
    },
    async lookup(workspace, run) {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("automation_deliveries")
            .select("envelope")
            .where("workspace", "=", workspace)
            .where("run", "=", run)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? JSON.parse(row.envelope) : null;
    },
  };
  return {
    automation,
    workspaces,
    workspaceSettings,
    users,
    memberships,
    projects,
    statuses,
    tasks,
    outbox,
  };
}
