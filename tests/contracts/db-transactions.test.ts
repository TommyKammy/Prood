import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSystemIdGenerator, type WorkspaceRepository } from "@prood/application";
import type { DbDriverKind } from "@prood/contracts";
import {
  isPersistenceError,
  sleep,
  type DatabaseClient,
  type KyselyBackedDatabaseClient,
} from "@prood/persistence-common";
import {
  createPostgresDatabase,
  createPostgresSchema,
  dropPostgresSchema,
  mapPostgresError,
} from "@prood/persistence-postgres";
import { createSqliteDatabase, mapSqliteError } from "@prood/persistence-sqlite";

const targetDb = process.env.PROOD_TEST_DB as DbDriverKind | undefined;
if (targetDb !== "sqlite" && targetDb !== "postgres") {
  throw new Error(
    `PROOD_TEST_DB must be "sqlite" or "postgres" (received: ${String(targetDb)})`,
  );
}

interface ClientOverrides {
  busyTimeoutMs?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  maxRetryAttempts?: number;
  retryBaseDelayMs?: number;
}

interface IsolatedDbContext {
  openClient(overrides?: ClientOverrides): DatabaseClient;
  cleanup(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

async function createIsolatedDbContext(): Promise<IsolatedDbContext> {
  const openedClients: DatabaseClient[] = [];

  if (targetDb === "sqlite") {
    const dir = mkdtempSync(join(tmpdir(), "prood-tx-sqlite-"));
    const filePath = join(dir, "prood.sqlite");

    const ctx: IsolatedDbContext = {
      openClient(overrides = {}) {
        const client = createSqliteDatabase({
          filePath,
          busyTimeoutMs: overrides.busyTimeoutMs,
          maxRetryAttempts: overrides.maxRetryAttempts,
          retryBaseDelayMs: overrides.retryBaseDelayMs,
        });
        openedClients.push(client);
        return client;
      },
      async cleanup() {
        for (const client of openedClients.splice(0)) {
          await client.close();
        }
        rmSync(dir, { recursive: true, force: true });
      },
    };
    cleanups.push(() => ctx.cleanup());
    return ctx;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set when PROOD_TEST_DB=postgres");
  }

  const schema = `prood_test_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await createPostgresSchema(connectionString, schema);

  const ctx: IsolatedDbContext = {
    openClient(overrides = {}) {
      const client = createPostgresDatabase({
        connectionString,
        schema,
        lockTimeoutMs: overrides.lockTimeoutMs,
        statementTimeoutMs: overrides.statementTimeoutMs,
        maxRetryAttempts: overrides.maxRetryAttempts,
        retryBaseDelayMs: overrides.retryBaseDelayMs,
      });
      openedClients.push(client);
      return client;
    },
    async cleanup() {
      for (const client of openedClients.splice(0)) {
        await client.close();
      }
      await dropPostgresSchema(connectionString, schema);
    },
  };
  cleanups.push(() => ctx.cleanup());
  return ctx;
}

function createBarrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

class BusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessRuleError";
  }
}

describe(`DB migrations, UnitOfWork, error mapping & concurrency (${targetDb})`, () => {
  it("applies migrations on an empty DB and is idempotent on re-run", async () => {
    const ctx = await createIsolatedDbContext();
    const db = ctx.openClient();

    expect(await db.getAppliedMigrationVersions()).toEqual([]);

    const first = await db.migrate();
    expect(first).toEqual({ appliedVersions: [1, 2, 3, 4, 5, 6, 8], currentVersion: 8 });
    expect(await db.getAppliedMigrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 8]);

    const second = await db.migrate();
    expect(second).toEqual({ appliedVersions: [], currentVersion: 8 });
  });

  it("serializes concurrent migrate() calls on a fresh DB without duplicate application", async () => {
    const ctx = await createIsolatedDbContext();
    const clientA = ctx.openClient({ maxRetryAttempts: 5, retryBaseDelayMs: 25 });
    const clientB = ctx.openClient({ maxRetryAttempts: 5, retryBaseDelayMs: 25 });

    expect(await clientA.getAppliedMigrationVersions()).toEqual([]);

    const [resA, resB] = await Promise.all([clientA.migrate(), clientB.migrate()]);
    const allApplied = [...resA.appliedVersions, ...resB.appliedVersions].sort(
      (a, b) => a - b,
    );

    expect(allApplied).toEqual([1, 2, 3, 4, 5, 6, 8]);
    expect(resA.currentVersion).toBe(8);
    expect(resB.currentVersion).toBe(8);
    expect(await clientA.getAppliedMigrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 8]);
    expect(await clientB.getAppliedMigrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 8]);
  });

  it("upgrades from v1 with existing workspace rows and backfills workspace_settings", async () => {
    const ctx = await createIsolatedDbContext();
    const db = ctx.openClient();
    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    const now = "2026-11-27T10:00:00.000Z";

    const v1Result = await db.migrate({ targetVersion: 1 });
    expect(v1Result).toEqual({ appliedVersions: [1], currentVersion: 1 });

    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "alpha",
        name: "Alpha Team",
        createdAt: now,
      });
    });

    const v2Result = await db.migrate();
    expect(v2Result).toEqual({ appliedVersions: [2, 3, 4, 5, 6, 8], currentVersion: 8 });

    const verify = await db.uow.run(async (repos) => ({
      workspace: await repos.workspaces.findById(wksId),
      settings: await repos.workspaceSettings.findByWorkspaceId(wksId),
    }));

    expect(verify.workspace).toEqual({
      id: wksId,
      slug: "alpha",
      name: "Alpha Team",
      createdAt: now,
      updatedAt: now,
    });
    expect(verify.settings).toEqual({
      workspaceId: wksId,
      defaultLocale: "en",
      devProjectsEnabled: false,
      updatedAt: now,
    });
  });

  it("commits multiple writes atomically and persists across reconnect / separate session", async () => {
    const ctx = await createIsolatedDbContext();
    const db1 = ctx.openClient();
    await db1.migrate();

    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    const now = "2026-11-27T10:05:00.000Z";

    await db1.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "core-eng",
        name: "Core Engineering",
        createdAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksId,
        defaultLocale: "en",
        devProjectsEnabled: true,
        updatedAt: now,
      });
    });

    await db1.close();

    const db2 = ctx.openClient();
    const loaded = await db2.uow.run(async (repos) => ({
      workspace: await repos.workspaces.findBySlug("core-eng"),
      settings: await repos.workspaceSettings.findByWorkspaceId(wksId),
    }));

    expect(loaded.workspace?.id).toBe(wksId);
    expect(loaded.settings?.devProjectsEnabled).toBe(true);
  });

  it("rolls back all writes and passes business errors through untouched", async () => {
    const ctx = await createIsolatedDbContext();
    const db = ctx.openClient();
    await db.migrate();

    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");

    let caught: unknown;
    try {
      await db.uow.run(async (repos) => {
        await repos.workspaces.create({
          id: wksId,
          slug: "aborted-biz",
          name: "Aborted Workspace",
          createdAt: "2026-11-27T10:10:00.000Z",
        });
        throw new BusinessRuleError("Workspace quota exceeded");
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BusinessRuleError);
    expect(isPersistenceError(caught)).toBe(false);

    const found = await db.uow.run((repos) => repos.workspaces.findById(wksId));
    expect(found).toBeNull();
  });

  it("rolls back first write when second write fails with FOREIGN_KEY_VIOLATION", async () => {
    const ctx = await createIsolatedDbContext();
    const db = ctx.openClient();
    await db.migrate();

    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    const missingWksId = ids.next("wks");

    let caught: unknown;
    try {
      await db.uow.run(async (repos) => {
        await repos.workspaces.create({
          id: wksId,
          slug: "aborted-fk",
          name: "Aborted FK Workspace",
          createdAt: "2026-11-27T10:15:00.000Z",
        });
        await repos.workspaceSettings.upsert({
          workspaceId: missingWksId,
          defaultLocale: "en",
          devProjectsEnabled: false,
          updatedAt: "2026-11-27T10:15:00.000Z",
        });
      });
    } catch (error) {
      caught = error;
    }

    expect(isPersistenceError(caught, "FOREIGN_KEY_VIOLATION")).toBe(true);
    if (isPersistenceError(caught)) {
      expect(caught.retryable).toBe(false);
    }

    const found = await db.uow.run((repos) => repos.workspaces.findById(wksId));
    expect(found).toBeNull();
  });

  it("maps UNIQUE_VIOLATION and enforces foreign keys after reconnect", async () => {
    const ctx = await createIsolatedDbContext();
    const db1 = ctx.openClient();
    await db1.migrate();

    const ids = createSystemIdGenerator();
    const wksId1 = ids.next("wks");
    const wksId2 = ids.next("wks");
    const now = "2026-11-27T10:20:00.000Z";

    await db1.uow.run((repos) =>
      repos.workspaces.create({
        id: wksId1,
        slug: "shared-slug",
        name: "First",
        createdAt: now,
      }),
    );

    let uniqueErr: unknown;
    try {
      await db1.uow.run((repos) =>
        repos.workspaces.create({
          id: wksId2,
          slug: "shared-slug",
          name: "Duplicate",
          createdAt: now,
        }),
      );
    } catch (error) {
      uniqueErr = error;
    }

    expect(isPersistenceError(uniqueErr, "UNIQUE_VIOLATION")).toBe(true);
    if (isPersistenceError(uniqueErr)) {
      expect(uniqueErr.retryable).toBe(false);
    }

    await db1.close();

    // Reopen fresh client (and new SQLite file connection) to confirm FK PRAGMA stays enabled
    const db2 = ctx.openClient();
    let fkErr: unknown;
    try {
      await db2.uow.run((repos) =>
        repos.workspaceSettings.upsert({
          workspaceId: ids.next("wks"),
          defaultLocale: "en",
          devProjectsEnabled: false,
          updatedAt: now,
        }),
      );
    } catch (error) {
      fkErr = error;
    }

    expect(isPersistenceError(fkErr, "FOREIGN_KEY_VIOLATION")).toBe(true);
  });

  it("fails boundedly on sustained cross-connection lock conflict and stays reusable afterward", async () => {
    const ctx = await createIsolatedDbContext();
    const setupDb = ctx.openClient();
    await setupDb.migrate();

    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    await setupDb.uow.run((repos) =>
      repos.workspaces.create({
        id: wksId,
        slug: "lock-target",
        name: "Initial Name",
        createdAt: "2026-11-27T10:25:00.000Z",
      }),
    );
    await setupDb.close();

    const holder = ctx.openClient({
      busyTimeoutMs: 2000,
      lockTimeoutMs: 2000,
      maxRetryAttempts: 0,
    });
    const contender = ctx.openClient({
      busyTimeoutMs: 80,
      lockTimeoutMs: 100,
      maxRetryAttempts: 2,
      retryBaseDelayMs: 25,
    });

    const lockAcquired = createBarrier();

    const holderPromise = holder.uow.run(async (repos) => {
      await repos.workspaces.updateName(
        wksId,
        "Holder Update",
        "2026-11-27T10:25:01.000Z",
      );
      lockAcquired.release();
      await sleep(700);
      return "holder-done";
    });

    await lockAcquired.promise;

    const startedAt = Date.now();
    let conflictErr: unknown;
    try {
      await contender.uow.run((repos) =>
        repos.workspaces.updateName(
          wksId,
          "Contender Failed Attempt",
          "2026-11-27T10:25:02.000Z",
        ),
      );
    } catch (error) {
      conflictErr = error;
    }
    const elapsedMs = Date.now() - startedAt;

    expect(isPersistenceError(conflictErr, "TRANSIENT_CONFLICT")).toBe(true);
    if (isPersistenceError(conflictErr)) {
      expect(conflictErr.retryable).toBe(true);
    }
    expect(elapsedMs).toBeLessThan(2000);

    await expect(holderPromise).resolves.toBe("holder-done");

    // Reuse the exact contender instance after its bounded conflict failure
    const recovered = await contender.uow.run((repos) =>
      repos.workspaces.updateName(
        wksId,
        "Contender Recovered",
        "2026-11-27T10:25:03.000Z",
      ),
    );
    expect(recovered?.name).toBe("Contender Recovered");
  });

  it("retries and succeeds when a brief cross-connection lock clears within the retry budget", async () => {
    const ctx = await createIsolatedDbContext();
    const setupDb = ctx.openClient();
    await setupDb.migrate();

    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    await setupDb.uow.run((repos) =>
      repos.workspaces.create({
        id: wksId,
        slug: "brief-lock-target",
        name: "Initial Name",
        createdAt: "2026-11-27T10:30:00.000Z",
      }),
    );
    await setupDb.close();

    const holder = ctx.openClient({
      busyTimeoutMs: 2000,
      lockTimeoutMs: 2000,
      maxRetryAttempts: 0,
    });
    const contender = ctx.openClient({
      busyTimeoutMs: 40,
      lockTimeoutMs: 50,
      maxRetryAttempts: 6,
      retryBaseDelayMs: 30,
    });

    const lockAcquired = createBarrier();

    const holderPromise = holder.uow.run(async (repos) => {
      await repos.workspaces.updateName(
        wksId,
        "Brief Holder",
        "2026-11-27T10:30:01.000Z",
      );
      lockAcquired.release();
      await sleep(90);
      return "holder-done";
    });

    await lockAcquired.promise;

    const contenderPromise = contender.uow.run((repos) =>
      repos.workspaces.updateName(
        wksId,
        "Contender After Retry",
        "2026-11-27T10:30:02.000Z",
      ),
    );

    const [holderResult, contenderResult] = await Promise.all([
      holderPromise,
      contenderPromise,
    ]);
    expect(holderResult).toBe("holder-done");
    expect(contenderResult?.name).toBe("Contender After Retry");
  });

  it("closes cleanly before first query, maps post-close calls to PersistenceError, and rejects reentrant uow.run and post-tx repos", async () => {
    const ctx = await createIsolatedDbContext();
    // 1. Close immediately before any query -> must cleanly dispose and fail with PersistenceError afterward
    const unusedDb = ctx.openClient();
    await unusedDb.close();

    let postCloseMigrateErr: unknown;
    try {
      await unusedDb.migrate();
    } catch (error) {
      postCloseMigrateErr = error;
    }
    expect(isPersistenceError(postCloseMigrateErr)).toBe(true);

    // 2. Reentrant uow.run fails fast with PersistenceError rather than deadlocking
    const db = ctx.openClient() as KyselyBackedDatabaseClient;
    await db.migrate();

    let reentrantErr: unknown;
    try {
      await db.uow.run(async () => {
        await db.uow.run(async () => "never");
      });
    } catch (error) {
      reentrantErr = error;
    }
    expect(isPersistenceError(reentrantErr)).toBe(true);

    // 3. Leaked repository called after uow.run finishes rejects cleanly
    let leakedRepo!: WorkspaceRepository;
    await db.uow.run(async (repos) => {
      leakedRepo = repos.workspaces;
    });
    let leakedErr: unknown;
    try {
      await leakedRepo.findBySlug("anything");
    } catch (error) {
      leakedErr = error;
    }
    expect(isPersistenceError(leakedErr)).toBe(true);

    // 4. Rejects NULL primary key with NOT_NULL_VIOLATION on both SQLite and PostgreSQL
    let nullPkErr: unknown;
    try {
      await db.kysely
        .insertInto("workspaces")
        .values({
          id: null as unknown as string,
          slug: "null-pk",
          name: "Null PK",
          created_at: "2026-11-27T00:00:00.000Z",
          updated_at: "2026-11-27T00:00:00.000Z",
        })
        .execute();
    } catch (error) {
      nullPkErr = error;
    }
    try {
      if (targetDb === "sqlite") {
        mapSqliteError(nullPkErr);
      } else {
        mapPostgresError(nullPkErr);
      }
    } catch (mapped) {
      expect(isPersistenceError(mapped, "NOT_NULL_VIOLATION")).toBe(true);
    }

    // 5. Case-insensitive email & slug normalization in repositories
    const ids = createSystemIdGenerator();
    const wksId = ids.next("wks");
    const usrId = ids.next("usr");
    const now = "2026-11-27T10:35:00.000Z";
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "Mixed-Slug",
        name: "Mixed Slug",
        createdAt: now,
      });
      await repos.users.create({
        id: usrId,
        email: "Mixed.Case@Example.COM",
        displayName: "Mixed Case",
        createdAt: now,
      });
    });
    const normalizedLookup = await db.uow.run(async (repos) => ({
      workspace: await repos.workspaces.findBySlug("mixed-slug"),
      user: await repos.users.findByEmail("mixed.case@example.com"),
    }));
    expect(normalizedLookup.workspace?.id).toBe(wksId);
    expect(normalizedLookup.user?.id).toBe(usrId);

    // 5b. Pre-existing mixed-case records inserted prior to normalization remain reachable
    const legacyWksId = ids.next("wks");
    const legacyUsrId = ids.next("usr");
    await db.kysely
      .insertInto("workspaces")
      .values({
        id: legacyWksId,
        slug: "Legacy-Mixed",
        name: "Legacy Mixed Workspace",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db.kysely
      .insertInto("users")
      .values({
        id: legacyUsrId,
        email: "Legacy.Mixed@Example.COM",
        display_name: "Legacy Mixed User",
        created_at: now,
        updated_at: now,
      })
      .execute();
    const legacyLookup = await db.uow.run(async (repos) => ({
      wsExact: await repos.workspaces.findBySlug("Legacy-Mixed"),
      wsLower: await repos.workspaces.findBySlug("legacy-mixed"),
      usrExact: await repos.users.findByEmail("Legacy.Mixed@Example.COM"),
      usrLower: await repos.users.findByEmail("legacy.mixed@example.com"),
    }));
    expect(legacyLookup.wsExact?.id).toBe(legacyWksId);
    expect(legacyLookup.wsLower?.id).toBe(legacyWksId);
    expect(legacyLookup.usrExact?.id).toBe(legacyUsrId);
    expect(legacyLookup.usrLower?.id).toBe(legacyUsrId);

    // 6. Error mappers unwrap nested cause / AggregateError, classify CONNECTION_ERROR, and make PG 57014 non-retryable
    try {
      mapPostgresError(
        new Error("wrapped", {
          cause: new AggregateError(
            [Object.assign(new Error("refused"), { code: "ECONNREFUSED" })],
            "connect",
          ),
        }),
      );
    } catch (mapped) {
      expect(isPersistenceError(mapped, "CONNECTION_ERROR")).toBe(true);
    }
    try {
      mapPostgresError(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
    } catch (mapped) {
      expect(isPersistenceError(mapped, "TRANSIENT_CONFLICT")).toBe(false);
      if (isPersistenceError(mapped)) {
        expect(mapped.retryable).toBe(false);
      }
    }
    try {
      mapSqliteError(
        new Error("wrapped", {
          cause: Object.assign(new Error("cannot open"), { code: "SQLITE_CANTOPEN" }),
        }),
      );
    } catch (mapped) {
      expect(isPersistenceError(mapped, "CONNECTION_ERROR")).toBe(true);
    }
  });
});
