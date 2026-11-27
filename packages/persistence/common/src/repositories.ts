import type { Kysely, Transaction } from "kysely";
import type {
  AuthIdentityRecord,
  CreateMembershipInput,
  CreateUserInput,
  CreateWorkspaceInput,
  LinkAuthIdentityInput,
  TransactionRepositories,
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
  type LocaleCode,
  type MembershipId,
  type UserId,
  type WorkspaceId,
  type WorkspaceRole,
} from "@prood/domain";
import type {
  AuthIdentityTable,
  ProodDatabase,
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

  return { workspaces, workspaceSettings, users, memberships };
}
