import { sql, type Kysely, type Transaction } from "kysely";
import type {
  AppendOutboxEventInput,
  AuthIdentityRecord,
  CreateIdempotencyRecordInput,
  CreateIssueKeyNamespaceInput,
  CreateMembershipInput,
  CreateProjectInput,
  CreateProjectStatusInput,
  CreateTaskInput,
  CreateTaskIssueKeyInput,
  CreateUserInput,
  CreateWorkspaceInput,
  IdempotencyRecord,
  IdempotencyRepository,
  IssueKeyNamespaceRecord,
  IssueKeyPrefixRecord,
  IssueKeyRepository,
  LinkAuthIdentityInput,
  OutboxEventRecord,
  OutboxRepository,
  PatchWorkspaceSettingsInput,
  ProjectMembershipRecord,
  ProjectRecord,
  ProjectRepository,
  ProjectStatusRecord,
  ProjectStatusRepository,
  TaskIssueKeyView,
  TaskRecord,
  TaskRepository,
  TransactionRepositories,
  UpdateIssueKeyNamespaceInput,
  UpdateProjectStatusInput,
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
import type { DbDriverKind, WorkspaceMembershipSummary } from "@prood/contracts";
import {
  DEFAULT_LOCALE,
  normalizeEmail,
  type ActorType,
  type EventChannel,
  type EventId,
  type EventOutcome,
  type LocaleCode,
  type MembershipId,
  type NamespaceId,
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
  IdempotencyRecordTable,
  IssueKeyNamespaceTable,
  IssueKeyPrefixTable,
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

/**
 * Returns true when a trimmed query requires JavaScript Unicode NFC/lowercase
 * matching rather than SQL `lower()`, because SQLite's built-in `lower()` only
 * folds ASCII A-Z while PostgreSQL depends on collation.
 */
function needsUnicodeJsFilter(query: string): boolean {
  const nfc = query.normalize("NFC");
  if (nfc !== query) {
    return true;
  }
  for (const ch of nfc) {
    if (ch.charCodeAt(0) > 0x7f && ch.toLowerCase() !== ch.toUpperCase()) {
      return true;
    }
  }
  return false;
}

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
    version: Number((row as { version?: number }).version ?? 1),
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

function toIdempotencyRecord(row: IdempotencyRecordTable): IdempotencyRecord {
  return {
    actorUserId: row.actor_user_id as UserId,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    workspaceId: row.workspace_id as WorkspaceId | null,
    projectId: row.project_id as ProjectId | null,
    targetType: row.target_type,
    targetId: row.target_id,
    responseJson: row.response_json,
    createdAt: row.created_at,
  };
}

function toIssueKeyNamespaceRecord(
  row: IssueKeyNamespaceTable,
): IssueKeyNamespaceRecord {
  return {
    id: row.id as NamespaceId,
    workspaceId: row.workspace_id as WorkspaceId,
    projectId: row.project_id as ProjectId | null,
    currentPrefix: row.current_prefix,
    branchPrefix: row.branch_prefix,
    startStatusId: row.start_status_id as StatusId | null,
    enabledBy: row.enabled_by as UserId | null,
    enabledAt: row.enabled_at,
    updatedAt: row.updated_at,
  };
}

function toIssueKeyPrefixRecord(
  row: IssueKeyPrefixTable,
): IssueKeyPrefixRecord {
  return {
    workspaceId: row.workspace_id as WorkspaceId,
    prefix: row.prefix,
    namespaceId: row.namespace_id as NamespaceId,
    createdAt: row.created_at,
  };
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

const IN_CLAUSE_BATCH_SIZE = 200;

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
  driver: DbDriverKind = "sqlite",
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

    async patch(
      input: PatchWorkspaceSettingsInput,
    ): Promise<WorkspaceSettingsRecord> {
      const updatePatch: {
        updated_at: string;
        default_locale?: string;
        dev_projects_enabled?: number;
      } = {
        updated_at: input.updatedAt,
      };
      if (input.defaultLocale !== undefined) {
        updatePatch.default_locale = input.defaultLocale;
      }
      if (input.devProjectsEnabled !== undefined) {
        updatePatch.dev_projects_enabled = input.devProjectsEnabled ? 1 : 0;
      }

      const row = await runQuery(
        () =>
          executor
            .insertInto("workspace_settings")
            .values({
              workspace_id: input.workspaceId,
              default_locale: input.defaultLocale ?? DEFAULT_LOCALE,
              dev_projects_enabled: input.devProjectsEnabled ? 1 : 0,
              updated_at: input.updatedAt,
            })
            .onConflict((oc) =>
              oc.column("workspace_id").doUpdateSet(updatePatch),
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

    async deleteByWorkspaceAndUser(
      workspaceId: WorkspaceId,
      userId: UserId,
    ): Promise<boolean> {
      const row = await runQuery(
        () =>
          executor
            .deleteFrom("workspace_memberships")
            .where("workspace_id", "=", workspaceId)
            .where("user_id", "=", userId)
            .returning("id")
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row !== undefined;
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

    async findByIdForUpdate(id: ProjectId): Promise<ProjectRecord | null> {
      const row = await runQuery(
        () => {
          let query = executor
            .selectFrom("projects")
            .selectAll()
            .where("id", "=", id)
            .where("archived_at", "is", null);
          if (driver === "postgres") {
            query = query.forUpdate();
          }
          return query.executeTakeFirst();
        },
        mapError,
        assertActive,
      );
      return row ? toProjectRecord(row) : null;
    },

    async lockForTaskWrite(id: ProjectId): Promise<boolean> {
      const row = await runQuery(
        () => {
          let query = executor
            .selectFrom("projects")
            .select("id")
            .where("id", "=", id)
            .where("archived_at", "is", null);
          if (driver === "postgres") {
            query = query.forKeyShare();
          }
          return query.executeTakeFirst();
        },
        mapError,
        assertActive,
      );
      return row !== undefined;
    },

    async updateKind(
      id: ProjectId,
      kind: ProjectKind,
      updatedAt: string,
    ): Promise<ProjectRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .updateTable("projects")
            .set({ kind, updated_at: updatedAt })
            .where("id", "=", id)
            .where("archived_at", "is", null)
            .returningAll()
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

    async deleteMembership(
      projectId: ProjectId,
      userId: UserId,
    ): Promise<boolean> {
      const row = await runQuery(
        () =>
          executor
            .deleteFrom("project_memberships")
            .where("project_id", "=", projectId)
            .where("user_id", "=", userId)
            .returning("id")
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row !== undefined;
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

    async update(
      id: StatusId,
      input: UpdateProjectStatusInput,
    ): Promise<ProjectStatusRecord | null> {
      const patch: Record<string, unknown> = {
        updated_at: input.updatedAt,
      };
      if (input.name !== undefined) {
        patch.name = input.name;
      }
      if (input.position !== undefined) {
        patch.position = input.position;
      }
      const row = await runQuery(
        () =>
          executor
            .updateTable("project_statuses")
            .set(patch)
            .where("id", "=", id)
            .returningAll()
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toProjectStatusRecord(row) : null;
    },

    async deleteById(id: StatusId): Promise<boolean> {
      const row = await runQuery(
        () =>
          executor
            .deleteFrom("project_statuses")
            .where("id", "=", id)
            .returning("id")
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row !== undefined;
    },
  };

  const tasks: TaskRepository = {
    async create(input: CreateTaskInput): Promise<TaskRecord> {
      const row = await runQuery(
        () =>
          executor
            .insertInto("tasks")
            .values({
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
            .$if(driver === "postgres" && forUpdate, q=>q.forUpdate())
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toTaskRecord(row) : null;
    },

    async lockByIdsForUpdate(
      ids: readonly TaskPublicId[],
    ): Promise<TaskRecord[]> {
      // Sort ascending to acquire row locks in a canonical order and prevent deadlocks.
      const sortedUniqueIds = Array.from(new Set(ids)).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      if (sortedUniqueIds.length === 0) {
        return [];
      }

      const results: TaskRecord[] = [];
      for (let i = 0; i < sortedUniqueIds.length; i += IN_CLAUSE_BATCH_SIZE) {
        const chunk = sortedUniqueIds.slice(i, i + IN_CLAUSE_BATCH_SIZE);
        const rows = await runQuery(
          () => {
            let query = executor
              .selectFrom("tasks")
              .selectAll()
              .where("id", "in", chunk)
              .orderBy("id", "asc");
            if (driver === "postgres") {
              query = query.forUpdate();
            }
            return query.execute();
          },
          mapError,
          assertActive,
        );
        for (const row of rows) {
          results.push(toTaskRecord(row));
        }
      }
      return results;
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

    async searchInWorkspace(input: {
      workspaceId: WorkspaceId;
      allowedProjectIds: readonly ProjectId[];
      query: string;
      limit: number;
      before?: { updatedAt: string; id: TaskPublicId };
    }): Promise<TaskRecord[]> {
      const uniqueProjectIds = Array.from(new Set(input.allowedProjectIds));
      if (uniqueProjectIds.length === 0 || input.limit <= 0) {
        return [];
      }

      const fetchPage = async (
        beforeCursor: { updatedAt: string; id: TaskPublicId } | undefined,
        pageLimit: number,
        sqlLowerPattern: string | null,
      ): Promise<TaskRecord[]> => {
        const byId = new Map<TaskPublicId, TaskRecord>();
        let chunkCount = 0;

        for (let i = 0; i < uniqueProjectIds.length; i += IN_CLAUSE_BATCH_SIZE) {
          const chunk = uniqueProjectIds.slice(i, i + IN_CLAUSE_BATCH_SIZE);
          const includeInheritedNulls = i === 0;
          chunkCount += 1;
          const rows = await runQuery(
            () => {
              let queryBuilder = executor
                .selectFrom("tasks")
                .selectAll()
                .where("workspace_id", "=", input.workspaceId)
                .where((eb) =>
                  includeInheritedNulls
                    ? eb.or([
                        eb("project_id", "in", chunk),
                        eb("project_id", "is", null),
                      ])
                    : eb("project_id", "in", chunk),
                );
              if (sqlLowerPattern !== null) {
                queryBuilder = queryBuilder.where((eb) =>
                  eb.or([
                    sql<boolean>`lower(${eb.ref("title")}) LIKE ${sqlLowerPattern} ESCAPE '\\'`,
                    sql<boolean>`lower(${eb.ref("description")}) LIKE ${sqlLowerPattern} ESCAPE '\\'`,
                  ]),
                );
              }
              if (beforeCursor) {
                const { updatedAt, id } = beforeCursor;
                queryBuilder = queryBuilder.where((eb) =>
                  eb.or([
                    eb("updated_at", "<", updatedAt),
                    eb.and([
                      eb("updated_at", "=", updatedAt),
                      eb("id", "<", id),
                    ]),
                  ]),
                );
              }
              return queryBuilder
                .orderBy("updated_at", "desc")
                .orderBy("id", "desc")
                .limit(pageLimit)
                .execute();
            },
            mapError,
            assertActive,
          );
          for (const row of rows) {
            const rec = toTaskRecord(row);
            if (!byId.has(rec.id)) {
              byId.set(rec.id, rec);
            }
          }
        }

        const results = Array.from(byId.values());
        if (chunkCount > 1) {
          results.sort((a, b) => {
            if (a.updatedAt !== b.updatedAt) {
              return a.updatedAt > b.updatedAt ? -1 : 1;
            }
            if (a.id !== b.id) {
              return a.id > b.id ? -1 : 1;
            }
            return 0;
          });
        }
        return results.slice(0, pageLimit);
      };

      const trimmedQuery = input.query.trim();
      if (trimmedQuery.length === 0) {
        return fetchPage(input.before, input.limit, null);
      }

      if (!needsUnicodeJsFilter(trimmedQuery)) {
        const folded = trimmedQuery.toLowerCase();
        const escapedPattern = `%${folded.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        return fetchPage(input.before, input.limit, escapedPattern);
      }

      const needle = trimmedQuery.normalize("NFC").toLowerCase();
      const matched: TaskRecord[] = [];
      let scanBefore = input.before;
      const scanBatchSize = Math.min(Math.max(input.limit * 4, 200), 500);

      while (matched.length < input.limit) {
        const rawRows = await fetchPage(scanBefore, scanBatchSize, null);
        if (rawRows.length === 0) {
          break;
        }
        for (const row of rawRows) {
          if (
            row.title.normalize("NFC").toLowerCase().includes(needle) ||
            row.description.normalize("NFC").toLowerCase().includes(needle)
          ) {
            matched.push(row);
            if (matched.length >= input.limit) {
              break;
            }
          }
        }
        if (matched.length >= input.limit || rawRows.length < scanBatchSize) {
          break;
        }
        const lastRaw = rawRows[rawRows.length - 1]!;
        scanBefore = { updatedAt: lastRaw.updatedAt, id: lastRaw.id };
      }

      return matched;
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
      if (input.projectId !== undefined) {
        patch.project_id = input.projectId;
      }
      if (input.parentTaskId !== undefined) {
        patch.parent_task_id = input.parentTaskId;
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

    async clearParentTaskIds(
      taskIds: readonly TaskPublicId[],
      updatedAt: string,
    ): Promise<void> {
      const uniqueIds = Array.from(new Set(taskIds));
      for (let i = 0; i < uniqueIds.length; i += IN_CLAUSE_BATCH_SIZE) {
        const chunk = uniqueIds.slice(i, i + IN_CLAUSE_BATCH_SIZE);
        await runQuery(
          () =>
            executor
              .updateTable("tasks")
              .set({
                parent_task_id: null,
                updated_at: updatedAt,
                version: sql<number>`version + 1`,
              })
              .where("id", "in", chunk)
              .execute(),
          mapError,
          assertActive,
        );
      }
    },

    async updateStatusForTaskIds(
      taskIds: readonly TaskPublicId[],
      statusId: StatusId | null,
      updatedAt: string,
    ): Promise<void> {
      const uniqueIds = Array.from(new Set(taskIds));
      for (let i = 0; i < uniqueIds.length; i += IN_CLAUSE_BATCH_SIZE) {
        const chunk = uniqueIds.slice(i, i + IN_CLAUSE_BATCH_SIZE);
        await runQuery(
          () =>
            executor
              .updateTable("tasks")
              .set({
                status_id: statusId,
                updated_at: updatedAt,
                version: sql<number>`version + 1`,
              })
              .where("id", "in", chunk)
              .execute(),
          mapError,
          assertActive,
        );
      }
    },

    async replaceStatusInProject(
      _projectId: ProjectId,
      fromStatusId: StatusId,
      toStatusId: StatusId | null,
      updatedAt: string,
    ): Promise<void> {
      await runQuery(
        () =>
          executor
            .updateTable("tasks")
            .set({
              status_id: toStatusId,
              updated_at: updatedAt,
              version: sql<number>`version + 1`,
            })
            .where("status_id", "=", fromStatusId)
            .execute(),
        mapError,
        assertActive,
      );
    },

    async deleteById(id: TaskPublicId): Promise<boolean> {
      const row = await runQuery(
        () =>
          executor
            .deleteFrom("tasks")
            .where("id", "=", id)
            .returning("id")
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row !== undefined;
    },
  };

  const issueKeys: IssueKeyRepository = {
    async createNamespace(
      input: CreateIssueKeyNamespaceInput,
    ): Promise<IssueKeyNamespaceRecord> {
      const row = await runQuery(
        () =>
          executor
            .insertInto("issue_key_namespaces")
            .values({
              id: input.id,
              workspace_id: input.workspaceId,
              project_id: input.projectId,
              current_prefix: input.currentPrefix,
              branch_prefix: input.branchPrefix,
              start_status_id: input.startStatusId,
              enabled_by: input.enabledBy,
              enabled_at: input.enabledAt,
              updated_at: input.enabledAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        mapError,
        assertActive,
      );
      return toIssueKeyNamespaceRecord(row);
    },

    async findNamespaceByProjectId(
      projectId: ProjectId,
    ): Promise<IssueKeyNamespaceRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("issue_key_namespaces")
            .selectAll()
            .where("project_id", "=", projectId)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toIssueKeyNamespaceRecord(row) : null;
    },

    async findNamespaceByProjectIdForUpdate(
      projectId: ProjectId,
    ): Promise<IssueKeyNamespaceRecord | null> {
      const row = await runQuery(
        () => {
          let query = executor
            .selectFrom("issue_key_namespaces")
            .selectAll()
            .where("project_id", "=", projectId);
          if (driver === "postgres") {
            query = query.forUpdate();
          }
          return query.executeTakeFirst();
        },
        mapError,
        assertActive,
      );
      return row ? toIssueKeyNamespaceRecord(row) : null;
    },

    async findNamespacesByProjectIds(
      projectIds: readonly ProjectId[],
    ): Promise<IssueKeyNamespaceRecord[]> {
      const uniqueIds = Array.from(new Set(projectIds));
      if (uniqueIds.length === 0) {
        return [];
      }
      const results: IssueKeyNamespaceRecord[] = [];
      for (let i = 0; i < uniqueIds.length; i += IN_CLAUSE_BATCH_SIZE) {
        const chunk = uniqueIds.slice(i, i + IN_CLAUSE_BATCH_SIZE);
        const rows = await runQuery(
          () =>
            executor
              .selectFrom("issue_key_namespaces")
              .selectAll()
              .where("project_id", "in", chunk)
              .execute(),
          mapError,
          assertActive,
        );
        for (const row of rows) {
          results.push(toIssueKeyNamespaceRecord(row));
        }
      }
      return results;
    },

    async updateNamespace(
      id: NamespaceId,
      input: UpdateIssueKeyNamespaceInput,
    ): Promise<IssueKeyNamespaceRecord | null> {
      const patch: Record<string, unknown> = {
        updated_at: input.updatedAt,
      };
      if (input.currentPrefix !== undefined) {
        patch.current_prefix = input.currentPrefix;
      }
      if (input.startStatusId !== undefined) {
        patch.start_status_id = input.startStatusId;
      }
      const row = await runQuery(
        () =>
          executor
            .updateTable("issue_key_namespaces")
            .set(patch)
            .where("id", "=", id)
            .returningAll()
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toIssueKeyNamespaceRecord(row) : null;
    },

    async listPrefixesByNamespace(
      namespaceId: NamespaceId,
    ): Promise<IssueKeyPrefixRecord[]> {
      const rows = await runQuery(
        () =>
          executor
            .selectFrom("issue_key_prefixes")
            .selectAll()
            .where("namespace_id", "=", namespaceId)
            .orderBy("created_at", "asc")
            .orderBy("prefix", "asc")
            .execute(),
        mapError,
        assertActive,
      );
      return rows.map(toIssueKeyPrefixRecord);
    },

    async listPrefixesByNamespaceIds(
      namespaceIds: readonly NamespaceId[],
    ): Promise<IssueKeyPrefixRecord[]> {
      const uniqueIds = Array.from(new Set(namespaceIds));
      if (uniqueIds.length === 0) {
        return [];
      }
      const results: IssueKeyPrefixRecord[] = [];
      let chunkCount = 0;
      for (let i = 0; i < uniqueIds.length; i += IN_CLAUSE_BATCH_SIZE) {
        const chunk = uniqueIds.slice(i, i + IN_CLAUSE_BATCH_SIZE);
        chunkCount += 1;
        const rows = await runQuery(
          () =>
            executor
              .selectFrom("issue_key_prefixes")
              .selectAll()
              .where("namespace_id", "in", chunk)
              .orderBy("created_at", "asc")
              .orderBy("prefix", "asc")
              .execute(),
          mapError,
          assertActive,
        );
        for (const row of rows) {
          results.push(toIssueKeyPrefixRecord(row));
        }
      }
      if (chunkCount > 1) {
        results.sort((a, b) => {
          if (a.createdAt !== b.createdAt) {
            return a.createdAt < b.createdAt ? -1 : 1;
          }
          if (a.prefix !== b.prefix) {
            return a.prefix < b.prefix ? -1 : 1;
          }
          return 0;
        });
      }
      return results;
    },

    async findPrefixOwner(
      workspaceId: WorkspaceId,
      prefix: string,
    ): Promise<IssueKeyPrefixRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("issue_key_prefixes")
            .selectAll()
            .where("workspace_id", "=", workspaceId)
            .where("prefix", "=", prefix)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toIssueKeyPrefixRecord(row) : null;
    },

    async findProjectIdByWorkspacePrefix(
      workspaceId: WorkspaceId,
      prefix: string,
    ): Promise<ProjectId | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("issue_key_prefixes")
            .innerJoin(
              "issue_key_namespaces",
              "issue_key_namespaces.id",
              "issue_key_prefixes.namespace_id",
            )
            .innerJoin(
              "projects",
              "projects.id",
              "issue_key_namespaces.project_id",
            )
            .select("issue_key_namespaces.project_id")
            .where("issue_key_prefixes.workspace_id", "=", workspaceId)
            .where("issue_key_prefixes.prefix", "=", prefix)
            .where("projects.archived_at", "is", null)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row?.project_id ? (row.project_id as ProjectId) : null;
    },

    async findProjectIdsByWorkspacesAndPrefix(
      workspaceIds: readonly WorkspaceId[],
      prefix: string,
    ): Promise<Array<{ workspaceId: WorkspaceId; projectId: ProjectId }>> {
      const uniqueWorkspaceIds = Array.from(new Set(workspaceIds));
      if (uniqueWorkspaceIds.length === 0) {
        return [];
      }
      const results: Array<{ workspaceId: WorkspaceId; projectId: ProjectId }> =
        [];
      for (let i = 0; i < uniqueWorkspaceIds.length; i += IN_CLAUSE_BATCH_SIZE) {
        const chunk = uniqueWorkspaceIds.slice(i, i + IN_CLAUSE_BATCH_SIZE);
        const rows = await runQuery(
          () =>
            executor
              .selectFrom("issue_key_prefixes")
              .innerJoin(
                "issue_key_namespaces",
                "issue_key_namespaces.id",
                "issue_key_prefixes.namespace_id",
              )
              .innerJoin(
                "projects",
                "projects.id",
                "issue_key_namespaces.project_id",
              )
              .select([
                "issue_key_prefixes.workspace_id",
                "issue_key_namespaces.project_id",
              ])
              .where("issue_key_prefixes.workspace_id", "in", chunk)
              .where("issue_key_prefixes.prefix", "=", prefix)
              .where("projects.archived_at", "is", null)
              .execute(),
          mapError,
          assertActive,
        );
        for (const row of rows) {
          if (row.project_id) {
            results.push({
              workspaceId: row.workspace_id as WorkspaceId,
              projectId: row.project_id as ProjectId,
            });
          }
        }
      }
      return results;
    },

    async findTaskIdByWorkspaceKey(
      workspaceId: WorkspaceId,
      prefix: string,
      issueNumber: number,
    ): Promise<TaskPublicId | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("issue_key_prefixes")
            .innerJoin(
              "task_issue_keys",
              "task_issue_keys.namespace_id",
              "issue_key_prefixes.namespace_id",
            )
            .select("task_issue_keys.task_id")
            .where("issue_key_prefixes.workspace_id", "=", workspaceId)
            .where("issue_key_prefixes.prefix", "=", prefix)
            .where("task_issue_keys.issue_number", "=", issueNumber)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? (row.task_id as TaskPublicId) : null;
    },

    async findTaskIdsByWorkspacesAndKey(
      workspaceIds: readonly WorkspaceId[],
      prefix: string,
      issueNumber: number,
    ): Promise<Array<{ workspaceId: WorkspaceId; taskId: TaskPublicId }>> {
      const uniqueWorkspaceIds = Array.from(new Set(workspaceIds));
      if (uniqueWorkspaceIds.length === 0) {
        return [];
      }
      const results: Array<{ workspaceId: WorkspaceId; taskId: TaskPublicId }> = [];
      for (let i = 0; i < uniqueWorkspaceIds.length; i += IN_CLAUSE_BATCH_SIZE) {
        const chunk = uniqueWorkspaceIds.slice(i, i + IN_CLAUSE_BATCH_SIZE);
        const rows = await runQuery(
          () =>
            executor
              .selectFrom("issue_key_prefixes")
              .innerJoin(
                "task_issue_keys",
                "task_issue_keys.namespace_id",
                "issue_key_prefixes.namespace_id",
              )
              .select([
                "issue_key_prefixes.workspace_id",
                "task_issue_keys.task_id",
              ])
              .where("issue_key_prefixes.workspace_id", "in", chunk)
              .where("issue_key_prefixes.prefix", "=", prefix)
              .where("task_issue_keys.issue_number", "=", issueNumber)
              .execute(),
          mapError,
          assertActive,
        );
        for (const row of rows) {
          results.push({
            workspaceId: row.workspace_id as WorkspaceId,
            taskId: row.task_id as TaskPublicId,
          });
        }
      }
      return results;
    },

    async reservePrefix(
      input: IssueKeyPrefixRecord,
    ): Promise<IssueKeyPrefixRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .insertInto("issue_key_prefixes")
            .values({
              workspace_id: input.workspaceId,
              prefix: input.prefix,
              namespace_id: input.namespaceId,
              created_at: input.createdAt,
            })
            .onConflict((oc) =>
              oc.columns(["workspace_id", "prefix"]).doNothing(),
            )
            .returningAll()
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toIssueKeyPrefixRecord(row) : null;
    },

    async initCounter(
      namespaceId: NamespaceId,
      nextNumber: number,
    ): Promise<void> {
      await runQuery(
        () =>
          executor
            .insertInto("issue_key_counters")
            .values({
              namespace_id: namespaceId,
              next_number: nextNumber,
            })
            .execute(),
        mapError,
        assertActive,
      );
    },

    async allocateNextNumber(namespaceId: NamespaceId): Promise<number> {
      const row = await runQuery(
        () =>
          executor
            .updateTable("issue_key_counters")
            .set((eb) => ({
              next_number: eb("next_number", "+", 1),
            }))
            .where("namespace_id", "=", namespaceId)
            .returning("next_number")
            .executeTakeFirstOrThrow(),
        mapError,
        assertActive,
      );
      return Number(row.next_number) - 1;
    },

    async createTaskKeys(
      entries: readonly CreateTaskIssueKeyInput[],
    ): Promise<void> {
      if (entries.length === 0) {
        return;
      }
      const INSERT_BATCH_SIZE = 150;
      for (let i = 0; i < entries.length; i += INSERT_BATCH_SIZE) {
        const chunk = entries.slice(i, i + INSERT_BATCH_SIZE);
        await runQuery(
          () =>
            executor
              .insertInto("task_issue_keys")
              .values(
                chunk.map((entry) => ({
                  task_id: entry.taskId,
                  namespace_id: entry.namespaceId,
                  issue_number: entry.issueNumber,
                  created_at: entry.createdAt,
                })),
              )
              .execute(),
          mapError,
          assertActive,
        );
      }
    },

    async findByTaskId(
      taskId: TaskPublicId,
    ): Promise<TaskIssueKeyView | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("task_issue_keys")
            .innerJoin(
              "issue_key_namespaces",
              "issue_key_namespaces.id",
              "task_issue_keys.namespace_id",
            )
            .select([
              "task_issue_keys.task_id",
              "task_issue_keys.namespace_id",
              "task_issue_keys.issue_number",
              "issue_key_namespaces.current_prefix",
              "issue_key_namespaces.branch_prefix",
              "task_issue_keys.created_at",
            ])
            .where("task_issue_keys.task_id", "=", taskId)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row
        ? {
            taskId: row.task_id as TaskPublicId,
            namespaceId: row.namespace_id as NamespaceId,
            issueNumber: Number(row.issue_number),
            currentPrefix: row.current_prefix,
            branchPrefix: row.branch_prefix,
            createdAt: row.created_at,
          }
        : null;
    },

    async findByTaskIds(
      taskIds: readonly TaskPublicId[],
    ): Promise<Map<TaskPublicId, TaskIssueKeyView>> {
      const result = new Map<TaskPublicId, TaskIssueKeyView>();
      const uniqueIds = Array.from(new Set(taskIds));
      if (uniqueIds.length === 0) {
        return result;
      }
      for (let i = 0; i < uniqueIds.length; i += IN_CLAUSE_BATCH_SIZE) {
        const chunk = uniqueIds.slice(i, i + IN_CLAUSE_BATCH_SIZE);
        const rows = await runQuery(
          () =>
            executor
              .selectFrom("task_issue_keys")
              .innerJoin(
                "issue_key_namespaces",
                "issue_key_namespaces.id",
                "task_issue_keys.namespace_id",
              )
              .select([
                "task_issue_keys.task_id",
                "task_issue_keys.namespace_id",
                "task_issue_keys.issue_number",
                "issue_key_namespaces.current_prefix",
                "issue_key_namespaces.branch_prefix",
                "task_issue_keys.created_at",
              ])
              .where("task_issue_keys.task_id", "in", chunk)
              .execute(),
          mapError,
          assertActive,
        );
        for (const row of rows) {
          const taskId = row.task_id as TaskPublicId;
          result.set(taskId, {
            taskId,
            namespaceId: row.namespace_id as NamespaceId,
            issueNumber: Number(row.issue_number),
            currentPrefix: row.current_prefix,
            branchPrefix: row.branch_prefix,
            createdAt: row.created_at,
          });
        }
      }
      return result;
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
            .$if(driver === "postgres", (q) => q.forUpdate().skipLocked())
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
    async routed(project, task, rule) {
      let query = executor
        .selectFrom("automation_deliveries as d")
        .leftJoin("automation_receipts as a", (j) =>
          j.onRef("a.event", "=", "d.event").onRef("a.rule", "=", "d.rule"),
        )
        .select(["d.envelope", "d.reason", "d.run"])
        .where("d.project", "=", project)
        .where("a.run", "is", null);
      if (rule) query = query.where("d.rule", "=", rule);
      if (task)
        query = query.where(
          driver === "postgres"
            ? sql<string>`d.envelope::jsonb #>> '{proposal,task}'`
            : sql<string>`json_extract(d.envelope,'$.proposal.task')`,
          "=",
          task,
        );
      return (
        await query
          .innerJoin("outbox_events as e", "e.event_id", "d.event")
          .select("e.occurred_at as at")
          .orderBy("e.occurred_at", "desc")
          .orderBy("d.event", "desc")
          .limit(100)
          .execute()
      ).map((r) => ({ delivery: JSON.parse(r.envelope), run: r.run, reason: r.reason, at: r.at }));
    },
    async members(workspace) {
      const rows = await executor
        .selectFrom("workspace_memberships as m")
        .innerJoin("users as u", "u.id", "m.user_id")
        .select(["u.id", "u.display_name as name"])
        .where("m.workspace_id", "=", workspace)
        .orderBy("u.display_name")
        .execute();
      return rows.map((r) => ({ ...r, id: r.id as UserId }));
    },
    async events(project, task, rule, sampleType) {
      let query = executor
        .selectFrom("outbox_events")
        .selectAll()
        .where("project_id", "=", project)
        .where("event_type", "in", [
          "task.created",
          "task.updated",
          "task.started",
          "task.manual",
          "automation.applied",
          "automation.denied",
          "automation.skipped",
          "automation.keep",
          "automation.undo",
          "automation.prepared",
          "automation.review",
          "automation.rule.publish",
          "automation.rule.stop",
        ]);
      if (sampleType) {
        query =
          sampleType === "task.updated"
            ? query.where("event_type", "in", ["task.updated", "task.started"])
            : query.where("event_type", "=", sampleType);
        query = query.where("target_type", "=", "task").where("outcome", "=", "succeeded");
      }
      if (task) query = query.where("target_id", "=", task);
      if (rule)
        query = query.where((eb) =>
          eb.or([
            eb("target_id", "=", rule),
            eb(
              driver === "postgres"
                ? sql<string>`payload_json::jsonb ->> 'rule'`
                : sql<string>`json_extract(payload_json,'$.rule')`,
              "=",
              rule,
            ),
          ]),
        );
      return (
        await query
          .orderBy("occurred_at", "desc")
          .orderBy("id", "desc")
          .limit(sampleType ? 1 : 100)
          .execute()
      ).map(toOutboxEventRecord);
    },
    async lockOperation(workspace, run) {
      // SQLite already owns the immediate transaction. PG also serializes requests that reuse
      // one operation key with different target tasks, which would otherwise lock different rows.
      if (driver === "postgres")
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([workspace, run])},0))`.execute(
          executor,
        );
    },
    async operationRun(event, rule) {
      return (
        (
          await executor
            .selectFrom("automation_receipts")
            .select("run")
            .where("event", "=", event)
            .where("rule", "=", rule)
            .executeTakeFirst()
        )?.run ?? null
      );
    },
    async confirmed(workspace, event, rule) {
      return (
        (
          await executor
            .selectFrom("automation_deliveries")
            .select("run")
            .where("workspace", "=", workspace)
            .where("event", "=", event)
            .where("rule", "=", rule)
            .executeTakeFirst()
        )?.run ?? null
      );
    },
    async receipt(workspace, run) {
      const row = await executor
        .selectFrom("automation_receipts")
        .select(["result", "decision"])
        .where("workspace", "=", workspace)
        .where("run", "=", run)
        .executeTakeFirst();
      return row ? { ...JSON.parse(row.result), decision: row.decision } : null;
    },
    async record(effect) {
      await executor
        .insertInto("automation_receipts")
        .values({
          workspace: effect.workspace,
          run: effect.run,
          event: effect.event,
          rule: effect.rule,
          result: JSON.stringify(effect),
          decision: null,
        })
        .executeTakeFirstOrThrow();
    },
    async decide(workspace, run, decision) {
      const row = await executor
        .updateTable("automation_receipts")
        .set({ decision })
        .where("workspace", "=", workspace)
        .where("run", "=", run)
        .where("decision", "is", null)
        .returning("run")
        .executeTakeFirst();
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

  const idempotency: IdempotencyRepository = {
    async findByKey(
      actorUserId: UserId,
      operation: string,
      idempotencyKey: string,
    ): Promise<IdempotencyRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .selectFrom("idempotency_records")
            .selectAll()
            .where("actor_user_id", "=", actorUserId)
            .where("operation", "=", operation)
            .where("idempotency_key", "=", idempotencyKey)
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toIdempotencyRecord(row) : null;
    },

    async createIfAbsent(
      input: CreateIdempotencyRecordInput,
    ): Promise<IdempotencyRecord | null> {
      const row = await runQuery(
        () =>
          executor
            .insertInto("idempotency_records")
            .values({
              actor_user_id: input.actorUserId,
              operation: input.operation,
              idempotency_key: input.idempotencyKey,
              request_fingerprint: input.requestFingerprint,
              workspace_id: input.workspaceId,
              project_id: input.projectId,
              target_type: input.targetType,
              target_id: input.targetId,
              response_json: input.responseJson,
              created_at: input.createdAt,
            })
            .onConflict((oc) =>
              oc
                .columns(["actor_user_id", "operation", "idempotency_key"])
                .doNothing(),
            )
            .returningAll()
            .executeTakeFirst(),
        mapError,
        assertActive,
      );
      return row ? toIdempotencyRecord(row) : null;
    },
  };
  return {
    automation,
    driver,
    workspaces,
    workspaceSettings,
    users,
    memberships,
    projects,
    statuses,
    tasks,
    issueKeys,
    outbox,
    idempotency,
  };
}
