import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
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
import { mapPostgresError } from "./errors.js";
import { POSTGRES_MIGRATIONS } from "./migrations.js";

export interface PostgresDatabaseOptions {
  connectionString: string;
  schema?: string;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  maxRetryAttempts?: number;
  retryBaseDelayMs?: number;
  onPoolError?: (error: Error) => void;
}

const VALID_PG_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function attachPoolErrorHandler(
  pool: Pool,
  onPoolError?: (error: Error) => void,
): void {
  pool.on("error", (error) => {
    if (onPoolError) {
      onPoolError(error);
      return;
    }
    console.error("[prood:postgres] idle pool client error:", error);
  });
}

export async function createPostgresSchema(
  connectionString: string,
  schema: string,
): Promise<void> {
  if (!VALID_PG_IDENTIFIER.test(schema)) {
    throw new RangeError(`Invalid PostgreSQL schema identifier: ${schema}`);
  }
  const pool = new Pool({ connectionString });
  attachPoolErrorHandler(pool);
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await pool.end();
  }
}

export async function dropPostgresSchema(
  connectionString: string,
  schema: string,
): Promise<void> {
  if (!VALID_PG_IDENTIFIER.test(schema)) {
    throw new RangeError(`Invalid PostgreSQL schema identifier: ${schema}`);
  }
  const pool = new Pool({ connectionString });
  attachPoolErrorHandler(pool);
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
}

/**
 * Creates a Kysely-backed PostgreSQL DatabaseClient with per-transaction
 * lock/statement timeouts, bounded transient conflict retry, pool error handling,
 * and advisory-locked migration tracking.
 */
export function createPostgresDatabase(
  options: PostgresDatabaseOptions,
): DatabaseClient {
  if (options.schema !== undefined && !VALID_PG_IDENTIFIER.test(options.schema)) {
    throw new RangeError(`Invalid PostgreSQL schema identifier: ${options.schema}`);
  }

  const lockTimeoutMs = Math.max(0, Math.trunc(options.lockTimeoutMs ?? 5000));
  const statementTimeoutMs = Math.max(
    0,
    Math.trunc(options.statementTimeoutMs ?? 15000),
  );
  const retryPolicy = {
    maxRetryAttempts: options.maxRetryAttempts ?? 3,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 25,
  };

  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.schema !== undefined
      ? { options: `-c search_path=${options.schema}` }
      : {}),
  });
  attachPoolErrorHandler(pool, options.onPoolError);

  const db = new Kysely<ProodDatabase>({
    dialect: new PostgresDialect({ pool }),
  });

  async function applyLocalTimeouts(executor: Kysely<ProodDatabase>): Promise<void> {
    try {
      await sql
        .raw(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`)
        .execute(executor);
      await sql
        .raw(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`)
        .execute(executor);
    } catch (error) {
      mapPostgresError(error);
    }
  }

  const uow: UnitOfWork = {
    async run<T>(fn: (repos: TransactionRepositories) => Promise<T>): Promise<T> {
      return executeWithTransientRetry(retryPolicy, async () => {
        let hasBusinessError = false;
        try {
          return await db.transaction().execute(async (trx) => {
            await applyLocalTimeouts(trx);

            try {
              return await fn(createKyselyRepositories(trx, mapPostgresError));
            } catch (error) {
              if (!isPersistenceError(error)) {
                hasBusinessError = true;
              }
              throw error;
            }
          });
        } catch (error) {
          if (hasBusinessError || isPersistenceError(error)) {
            throw error;
          }
          return mapPostgresError(error);
        }
      });
    },
  };

  async function ensureMigrationTable(executor: Kysely<ProodDatabase>): Promise<void> {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS prood_schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `.execute(executor);
    } catch (error) {
      mapPostgresError(error);
    }
  }

  async function readAppliedVersions(
    executor: Kysely<ProodDatabase> = db,
  ): Promise<number[]> {
    try {
      const rows = await executor
        .selectFrom("prood_schema_migrations")
        .select("version")
        .orderBy("version", "asc")
        .execute();
      return rows.map((row) => Number(row.version));
    } catch (error) {
      mapPostgresError(error);
    }
  }

  return {
    driver: "postgres",
    uow,

    async ping(): Promise<{ ok: true }> {
      try {
        const res = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(db);
        if (Number(res.rows[0]?.ok) !== 1) {
          throw new Error("PostgreSQL health ping failed");
        }
        return { ok: true };
      } catch (error) {
        if (isPersistenceError(error)) {
          throw error;
        }
        mapPostgresError(error);
      }
    },

    async migrate(runOptions?: MigrationRunOptions): Promise<MigrationRunResult> {
      const targetVersion = runOptions?.targetVersion;
      return executeWithTransientRetry(retryPolicy, async () => {
        try {
          return await db.transaction().execute(async (trx) => {
            await applyLocalTimeouts(trx);
            await sql`SELECT pg_advisory_xact_lock(hashtext('prood_migrations:' || current_schema())::bigint)`.execute(
              trx,
            );
            await ensureMigrationTable(trx);

            const appliedList = await readAppliedVersions(trx);
            const appliedSet = new Set(appliedList);

            const pending = POSTGRES_MIGRATIONS.filter(
              (m) =>
                !appliedSet.has(m.version) &&
                (targetVersion === undefined || m.version <= targetVersion),
            ).sort((a, b) => a.version - b.version);

            const newlyApplied: number[] = [];
            for (const migration of pending) {
              for (const statement of migration.statements) {
                await sql.raw(statement).execute(trx);
              }
              await trx
                .insertInto("prood_schema_migrations")
                .values({
                  version: migration.version,
                  name: migration.name,
                  applied_at: new Date().toISOString(),
                })
                .execute();
              newlyApplied.push(migration.version);
            }

            const finalVersions = await readAppliedVersions(trx);
            const currentVersion =
              finalVersions.length > 0
                ? finalVersions[finalVersions.length - 1]!
                : 0;
            return {
              appliedVersions: newlyApplied,
              currentVersion,
            };
          });
        } catch (error) {
          if (isPersistenceError(error)) {
            throw error;
          }
          mapPostgresError(error);
        }
      });
    },

    async getAppliedMigrationVersions(): Promise<number[]> {
      try {
        const res = await sql<{ table_name: string | null }>`
          SELECT to_regclass('prood_schema_migrations') AS table_name
        `.execute(db);
        if (!res.rows[0]?.table_name) {
          return [];
        }
        return readAppliedVersions(db);
      } catch (error) {
        if (isPersistenceError(error)) {
          throw error;
        }
        mapPostgresError(error);
      }
    },

    async close(): Promise<void> {
      await db.destroy();
    },
  };
}
