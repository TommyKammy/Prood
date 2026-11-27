import { isPersistenceError, PersistenceError } from "@prood/persistence-common";

/**
 * Converts SQLite driver errors into common `PersistenceError` instances.
 */
export function mapSqliteError(error: unknown): never {
  if (isPersistenceError(error)) {
    throw error;
  }

  const code = (error as { code?: unknown })?.code;
  const message =
    error instanceof Error ? error.message : String(error ?? "SQLite error");

  if (typeof code === "string") {
    if (
      code === "SQLITE_CONSTRAINT_UNIQUE" ||
      code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    ) {
      throw new PersistenceError(message, {
        code: "UNIQUE_VIOLATION",
        driver: "sqlite",
        retryable: false,
        cause: error,
      });
    }
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      throw new PersistenceError(message, {
        code: "FOREIGN_KEY_VIOLATION",
        driver: "sqlite",
        retryable: false,
        cause: error,
      });
    }
    if (code === "SQLITE_CONSTRAINT_NOTNULL") {
      throw new PersistenceError(message, {
        code: "NOT_NULL_VIOLATION",
        driver: "sqlite",
        retryable: false,
        cause: error,
      });
    }
    if (code === "SQLITE_CONSTRAINT_CHECK") {
      throw new PersistenceError(message, {
        code: "CHECK_VIOLATION",
        driver: "sqlite",
        retryable: false,
        cause: error,
      });
    }
    if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
      throw new PersistenceError(message, {
        code: "TRANSIENT_CONFLICT",
        driver: "sqlite",
        retryable: true,
        cause: error,
      });
    }
  }

  if (message.includes("UNIQUE constraint failed")) {
    throw new PersistenceError(message, {
      code: "UNIQUE_VIOLATION",
      driver: "sqlite",
      retryable: false,
      cause: error,
    });
  }
  if (message.includes("FOREIGN KEY constraint failed")) {
    throw new PersistenceError(message, {
      code: "FOREIGN_KEY_VIOLATION",
      driver: "sqlite",
      retryable: false,
      cause: error,
    });
  }
  if (message.includes("NOT NULL constraint failed")) {
    throw new PersistenceError(message, {
      code: "NOT_NULL_VIOLATION",
      driver: "sqlite",
      retryable: false,
      cause: error,
    });
  }
  if (message.includes("CHECK constraint failed")) {
    throw new PersistenceError(message, {
      code: "CHECK_VIOLATION",
      driver: "sqlite",
      retryable: false,
      cause: error,
    });
  }

  throw new PersistenceError(message, {
    code: "UNKNOWN_DB_ERROR",
    driver: "sqlite",
    retryable: false,
    cause: error,
  });
}
