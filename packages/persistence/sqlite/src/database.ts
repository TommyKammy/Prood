import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import type { TransactionRepositories, UnitOfWork } from "@prood/application";
import {
  createKyselyRepositories,
  executeWithTransientRetry,
  isPersistenceError,
  PersistenceError,
  type KyselyBackedDatabaseClient,
  type MigrationRunOptions,
  type MigrationRunResult,
  type ProodDatabase,
} from "@prood/persistence-common";
import { mapSqliteError } from "./errors.js";
import { SQLITE_MIGRATIONS } from "./migrations.js";

export interface SqliteDatabaseOptions {
  filePath: string;
  busyTimeoutMs?: number;
  maxRetryAttempts?: number;
  retryBaseDelayMs?: number;
}

function assertValidNonNegativeNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Invalid ${name}: ${value}`);
  }
  return Math.trunc(value);
}

/**
 * Opens a SQLite connection with per-connection PRAGMAs required by Prood:
 * bounded busy timeout first, then foreign key enforcement and WAL mode.
 */
export function openSqliteConnection(
  filePath: string,
  busyTimeoutMs = 5000,
): Database.Database {
  const safeTimeout = assertValidNonNegativeNumber("busyTimeoutMs", busyTimeoutMs);
  const db = new Database(filePath);
  try {
    db.pragma(`busy_timeout = ${safeTimeout}`);
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve initial PRAGMA error
    }
    throw error;
  }
}

/**
 * Creates a Kysely-backed SQLite DatabaseClient with `BEGIN IMMEDIATE`
 * transaction isolation, bounded transient conflict retry, and migration tracking.
 */
export function createSqliteDatabase(
  options: SqliteDatabaseOptions,
): KyselyBackedDatabaseClient {
  const busyTimeoutMs = assertValidNonNegativeNumber(
    "busyTimeoutMs",
    options.busyTimeoutMs ?? 5000,
  );
  const retryPolicy = {
    maxRetryAttempts: assertValidNonNegativeNumber(
      "maxRetryAttempts",
      options.maxRetryAttempts ?? 3,
    ),
    retryBaseDelayMs: assertValidNonNegativeNumber(
      "retryBaseDelayMs",
      options.retryBaseDelayMs ?? 25,
    ),
  };

  const nativeDb = openSqliteConnection(options.filePath, busyTimeoutMs);
  const db = new Kysely<ProodDatabase>({
    dialect: new SqliteDialect({ database: nativeDb }),
  });
  const txStorage = new AsyncLocalStorage<boolean>();
  let closePromise: Promise<void> | null = null;

  async function runImmediateTx<T>(
    conn: Kysely<ProodDatabase>,
    fn: (txConn: Kysely<ProodDatabase>, assertActive: () => void) => Promise<T>,
  ): Promise<T> {
    let inTx = false;
    let txActive = true;
    const assertActive = (): void => {
      if (!txActive) {
        throw new PersistenceError("Transaction is already finished", {
          code: "UNKNOWN_DB_ERROR",
          driver: "sqlite",
          retryable: false,
        });
      }
    };

    try {
      try {
        await sql`BEGIN IMMEDIATE`.execute(conn);
        inTx = true;
      } catch (error) {
        mapSqliteError(error);
      }

      const result = await fn(conn, assertActive);
      txActive = false;

      try {
        await sql`COMMIT`.execute(conn);
        inTx = false;
      } catch (error) {
        mapSqliteError(error);
      }
      return result;
    } catch (error) {
      txActive = false;
      if (inTx) {
        try {
          await sql`ROLLBACK`.execute(conn);
        } catch {
          // Preserve original error if rollback also fails
        }
      }
      throw error;
    }
  }

  const uow: UnitOfWork = {
    async run<T>(fn: (repos: TransactionRepositories) => Promise<T>): Promise<T> {
      if (txStorage.getStore() === true) {
        throw new PersistenceError("Reentrant UnitOfWork.run() is not supported", {
          code: "UNKNOWN_DB_ERROR",
          driver: "sqlite",
          retryable: false,
        });
      }

      return executeWithTransientRetry(retryPolicy, async () => {
        let hasBusinessError = false;
        let businessError: unknown;
        try {
          return await db.connection().execute(async (conn) =>
            runImmediateTx(conn, async (txConn, assertActive) =>
              txStorage.run(true, async () => {
                try {
                  return await fn(
                    createKyselyRepositories(
                      txConn,
                      mapSqliteError,
                      assertActive,
                      "sqlite",
                    ),
                  );
                } catch (error) {
                  if (!isPersistenceError(error)) {
                    hasBusinessError = true;
                    businessError = error;
                  }
                  throw error;
                }
              }),
            ),
          );
        } catch (error) {
          if ((hasBusinessError && error === businessError) || isPersistenceError(error)) {
            throw error;
          }
          return mapSqliteError(error);
        }
      });
    },
  };

  async function ensureMigrationTable(conn: Kysely<ProodDatabase>): Promise<void> {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS prood_schema_migrations (
          version INTEGER NOT NULL PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `.execute(conn);
    } catch (error) {
      mapSqliteError(error);
    }
  }

  async function readAppliedVersions(
    conn: Kysely<ProodDatabase>,
  ): Promise<number[]> {
    try {
      const rows = await conn
        .selectFrom("prood_schema_migrations")
        .select("version")
        .orderBy("version", "asc")
        .execute();
      return rows.map((row) => Number(row.version));
    } catch (error) {
      mapSqliteError(error);
    }
  }

  return {
    driver: "sqlite",
    kysely: db,
    uow,

    async ping(): Promise<{ ok: true }> {
      try {
        const res = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(db);
        if (Number(res.rows[0]?.ok) !== 1) {
          throw new Error("SQLite health ping failed");
        }
        return { ok: true };
      } catch (error) {
        if (isPersistenceError(error)) {
          throw error;
        }
        mapSqliteError(error);
      }
    },

    async migrate(runOptions?: MigrationRunOptions): Promise<MigrationRunResult> {
      const targetVersion = runOptions?.targetVersion;
      return executeWithTransientRetry(retryPolicy, async () => {
        try {
          return await db.connection().execute(async (conn) =>
            runImmediateTx(conn, async (txConn) => {
              await ensureMigrationTable(txConn);
              const appliedList = await readAppliedVersions(txConn);
              const appliedSet = new Set(appliedList);

              const pending = SQLITE_MIGRATIONS.filter(
                (m) =>
                  !appliedSet.has(m.version) &&
                  (targetVersion === undefined || m.version <= targetVersion),
              ).sort((a, b) => a.version - b.version);

              const newlyApplied: number[] = [];
              for (const migration of pending) {
                try {
                  for (const statement of migration.statements) {
                    await sql.raw(statement).execute(txConn);
                  }
                  await txConn
                    .insertInto("prood_schema_migrations")
                    .values({
                      version: migration.version,
                      name: migration.name,
                      applied_at: new Date().toISOString(),
                    })
                    .execute();
                } catch (error) {
                  mapSqliteError(error);
                }
                newlyApplied.push(migration.version);
              }

              const finalVersions = await readAppliedVersions(txConn);
              const currentVersion =
                finalVersions.length > 0
                  ? finalVersions[finalVersions.length - 1]!
                  : 0;
              return {
                appliedVersions: newlyApplied,
                currentVersion,
              };
            }),
          );
        } catch (error) {
          if (isPersistenceError(error)) {
            throw error;
          }
          mapSqliteError(error);
        }
      });
    },

    async getAppliedMigrationVersions(): Promise<number[]> {
      try {
        return await db.connection().execute(async (conn) => {
          const tableCheck = await sql<{ name: string }>`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'prood_schema_migrations'
          `.execute(conn);
          if (tableCheck.rows.length === 0) {
            return [];
          }
          return readAppliedVersions(conn);
        });
      } catch (error) {
        if (isPersistenceError(error)) {
          throw error;
        }
        mapSqliteError(error);
      }
    },

    close(): Promise<void> {
      if (!closePromise) {
        closePromise = (async () => {
          await db.destroy();
          if (nativeDb.open) {
            nativeDb.close();
          }
        })();
      }
      return closePromise;
    },
  };
}
