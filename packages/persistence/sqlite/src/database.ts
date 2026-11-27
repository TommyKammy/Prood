import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import type { TransactionRepositories, UnitOfWork } from "@prood/application";
import {
  createKyselyRepositories,
  executeWithTransientRetry,
  isPersistenceError,
  type DatabaseClient,
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

/**
 * Opens a SQLite connection with per-connection PRAGMAs required by Prood:
 * WAL mode, foreign key enforcement, and bounded busy timeout.
 */
export function openSqliteConnection(
  filePath: string,
  busyTimeoutMs = 5000,
): Database.Database {
  const safeTimeout = Math.max(0, Math.trunc(busyTimeoutMs));
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${safeTimeout}`);
  return db;
}

/**
 * Creates a Kysely-backed SQLite DatabaseClient with `BEGIN IMMEDIATE`
 * transaction isolation, bounded transient conflict retry, and migration tracking.
 */
export function createSqliteDatabase(
  options: SqliteDatabaseOptions,
): DatabaseClient {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  const retryPolicy = {
    maxRetryAttempts: options.maxRetryAttempts ?? 3,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 25,
  };

  const nativeDb = openSqliteConnection(options.filePath, busyTimeoutMs);
  const db = new Kysely<ProodDatabase>({
    dialect: new SqliteDialect({ database: nativeDb }),
  });

  async function runImmediateTx<T>(
    conn: Kysely<ProodDatabase>,
    fn: (txConn: Kysely<ProodDatabase>) => Promise<T>,
  ): Promise<T> {
    let inTx = false;
    try {
      try {
        await sql`BEGIN IMMEDIATE`.execute(conn);
        inTx = true;
      } catch (error) {
        mapSqliteError(error);
      }

      const result = await fn(conn);

      try {
        await sql`COMMIT`.execute(conn);
        inTx = false;
      } catch (error) {
        mapSqliteError(error);
      }
      return result;
    } catch (error) {
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
      return executeWithTransientRetry(retryPolicy, async () => {
        return db.connection().execute(async (conn) =>
          runImmediateTx(conn, async (txConn) =>
            fn(createKyselyRepositories(txConn, mapSqliteError)),
          ),
        );
      });
    },
  };

  async function ensureMigrationTable(conn: Kysely<ProodDatabase>): Promise<void> {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS prood_schema_migrations (
          version INTEGER PRIMARY KEY,
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
      return executeWithTransientRetry(retryPolicy, async () =>
        db.connection().execute(async (conn) => {
          await ensureMigrationTable(conn);
          const appliedList = await readAppliedVersions(conn);
          const appliedSet = new Set(appliedList);

          const pending = SQLITE_MIGRATIONS.filter(
            (m) =>
              !appliedSet.has(m.version) &&
              (targetVersion === undefined || m.version <= targetVersion),
          ).sort((a, b) => a.version - b.version);

          const newlyApplied: number[] = [];
          for (const migration of pending) {
            await runImmediateTx(conn, async (txConn) => {
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
            });
            newlyApplied.push(migration.version);
          }

          const finalVersions = await readAppliedVersions(conn);
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
    },

    async getAppliedMigrationVersions(): Promise<number[]> {
      return db.connection().execute(async (conn) => {
        await ensureMigrationTable(conn);
        return readAppliedVersions(conn);
      });
    },

    async close(): Promise<void> {
      await db.destroy();
    },
  };
}
