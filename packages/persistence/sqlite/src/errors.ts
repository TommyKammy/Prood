import { isPersistenceError, PersistenceError } from "@prood/persistence-common";

function collectErrorChain(root: unknown): unknown[] {
  const result: unknown[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    result.push(current);

    if (typeof current === "object") {
      const withCause = current as { cause?: unknown; errors?: unknown };
      if (withCause.cause !== undefined) {
        queue.push(withCause.cause);
      }
      if (Array.isArray(withCause.errors)) {
        for (const inner of withCause.errors) {
          queue.push(inner);
        }
      }
    }
  }

  return result;
}

/**
 * Converts SQLite driver errors into common `PersistenceError` instances.
 */
export function mapSqliteError(error: unknown): never {
  if (isPersistenceError(error)) {
    throw error;
  }

  const chain = collectErrorChain(error);
  const topMessage =
    error instanceof Error ? error.message : String(error ?? "SQLite error");

  for (const item of chain) {
    if (isPersistenceError(item)) {
      throw item;
    }

    const code = (item as { code?: unknown })?.code;
    const msg = item instanceof Error ? item.message : String(item ?? "");

    if (typeof code === "string") {
      if (
        code === "SQLITE_CONSTRAINT_UNIQUE" ||
        code === "SQLITE_CONSTRAINT_PRIMARYKEY"
      ) {
        throw new PersistenceError(topMessage, {
          code: "UNIQUE_VIOLATION",
          driver: "sqlite",
          retryable: false,
          cause: error,
        });
      }
      if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        throw new PersistenceError(topMessage, {
          code: "FOREIGN_KEY_VIOLATION",
          driver: "sqlite",
          retryable: false,
          cause: error,
        });
      }
      if (code === "SQLITE_CONSTRAINT_NOTNULL") {
        throw new PersistenceError(topMessage, {
          code: "NOT_NULL_VIOLATION",
          driver: "sqlite",
          retryable: false,
          cause: error,
        });
      }
      if (code === "SQLITE_CONSTRAINT_CHECK") {
        throw new PersistenceError(topMessage, {
          code: "CHECK_VIOLATION",
          driver: "sqlite",
          retryable: false,
          cause: error,
        });
      }
      if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
        throw new PersistenceError(topMessage, {
          code: "TRANSIENT_CONFLICT",
          driver: "sqlite",
          retryable: true,
          cause: error,
        });
      }
      if (
        code === "SQLITE_CANTOPEN" ||
        code.startsWith("SQLITE_IOERR") ||
        code === "SQLITE_NOTADB" ||
        code === "SQLITE_CORRUPT"
      ) {
        throw new PersistenceError(topMessage, {
          code: "CONNECTION_ERROR",
          driver: "sqlite",
          retryable: false,
          cause: error,
        });
      }
    }

    if (msg.includes("UNIQUE constraint failed")) {
      throw new PersistenceError(topMessage, {
        code: "UNIQUE_VIOLATION",
        driver: "sqlite",
        retryable: false,
        cause: error,
      });
    }
    if (msg.includes("FOREIGN KEY constraint failed")) {
      throw new PersistenceError(topMessage, {
        code: "FOREIGN_KEY_VIOLATION",
        driver: "sqlite",
        retryable: false,
        cause: error,
      });
    }
    if (msg.includes("NOT NULL constraint failed")) {
      throw new PersistenceError(topMessage, {
        code: "NOT_NULL_VIOLATION",
        driver: "sqlite",
        retryable: false,
        cause: error,
      });
    }
    if (msg.includes("CHECK constraint failed")) {
      throw new PersistenceError(topMessage, {
        code: "CHECK_VIOLATION",
        driver: "sqlite",
        retryable: false,
        cause: error,
      });
    }
    if (
      msg.includes("database is locked") ||
      msg.includes("database table is locked")
    ) {
      throw new PersistenceError(topMessage, {
        code: "TRANSIENT_CONFLICT",
        driver: "sqlite",
        retryable: true,
        cause: error,
      });
    }
    if (
      msg.includes("database connection is not open") ||
      msg.includes("driver has already been destroyed")
    ) {
      throw new PersistenceError(topMessage, {
        code: "CONNECTION_ERROR",
        driver: "sqlite",
        retryable: false,
        cause: error,
      });
    }
  }

  throw new PersistenceError(topMessage, {
    code: "UNKNOWN_DB_ERROR",
    driver: "sqlite",
    retryable: false,
    cause: error,
  });
}
