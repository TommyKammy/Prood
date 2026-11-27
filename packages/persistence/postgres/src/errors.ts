import { isPersistenceError, PersistenceError } from "@prood/persistence-common";

/**
 * Converts PostgreSQL driver SQLSTATE errors into common `PersistenceError` instances.
 */
export function mapPostgresError(error: unknown): never {
  if (isPersistenceError(error)) {
    throw error;
  }

  const pgErr = error as { code?: unknown; constraint?: unknown };
  const code = typeof pgErr?.code === "string" ? pgErr.code : undefined;
  const constraint =
    typeof pgErr?.constraint === "string" ? pgErr.constraint : undefined;
  const message =
    error instanceof Error ? error.message : String(error ?? "PostgreSQL error");

  if (code === "23505") {
    throw new PersistenceError(message, {
      code: "UNIQUE_VIOLATION",
      driver: "postgres",
      retryable: false,
      constraint,
      cause: error,
    });
  }
  if (code === "23503") {
    throw new PersistenceError(message, {
      code: "FOREIGN_KEY_VIOLATION",
      driver: "postgres",
      retryable: false,
      constraint,
      cause: error,
    });
  }
  if (code === "23502") {
    throw new PersistenceError(message, {
      code: "NOT_NULL_VIOLATION",
      driver: "postgres",
      retryable: false,
      constraint,
      cause: error,
    });
  }
  if (code === "23514") {
    throw new PersistenceError(message, {
      code: "CHECK_VIOLATION",
      driver: "postgres",
      retryable: false,
      constraint,
      cause: error,
    });
  }
  if (
    code === "40001" ||
    code === "40P01" ||
    code === "55P03" ||
    code === "57014"
  ) {
    throw new PersistenceError(message, {
      code: "TRANSIENT_CONFLICT",
      driver: "postgres",
      retryable: true,
      constraint,
      cause: error,
    });
  }
  if (code?.startsWith("08")) {
    throw new PersistenceError(message, {
      code: "CONNECTION_ERROR",
      driver: "postgres",
      retryable: true,
      constraint,
      cause: error,
    });
  }

  throw new PersistenceError(message, {
    code: "UNKNOWN_DB_ERROR",
    driver: "postgres",
    retryable: false,
    constraint,
    cause: error,
  });
}
