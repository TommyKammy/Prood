import { isPersistenceError, PersistenceError } from "@prood/persistence-common";

const NETWORK_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

const RETRYABLE_PG_CONNECTION_SQLSTATES = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
]);

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
 * Converts PostgreSQL driver SQLSTATE and connectivity errors into `PersistenceError`.
 */
export function mapPostgresError(error: unknown): never {
  if (isPersistenceError(error)) {
    throw error;
  }

  const chain = collectErrorChain(error);
  const topMessage =
    error instanceof Error ? error.message : String(error ?? "PostgreSQL error");

  for (const item of chain) {
    if (isPersistenceError(item)) {
      throw item;
    }

    const pgErr = item as { code?: unknown; constraint?: unknown };
    const code = typeof pgErr?.code === "string" ? pgErr.code : undefined;
    const constraint =
      typeof pgErr?.constraint === "string" ? pgErr.constraint : undefined;
    const msg = item instanceof Error ? item.message : String(item ?? "");

    if (code === "23505") {
      throw new PersistenceError(topMessage, {
        code: "UNIQUE_VIOLATION",
        driver: "postgres",
        retryable: false,
        constraint,
        cause: error,
      });
    }
    if (code === "23503") {
      throw new PersistenceError(topMessage, {
        code: "FOREIGN_KEY_VIOLATION",
        driver: "postgres",
        retryable: false,
        constraint,
        cause: error,
      });
    }
    if (code === "23502") {
      throw new PersistenceError(topMessage, {
        code: "NOT_NULL_VIOLATION",
        driver: "postgres",
        retryable: false,
        constraint,
        cause: error,
      });
    }
    if (code === "23514") {
      throw new PersistenceError(topMessage, {
        code: "CHECK_VIOLATION",
        driver: "postgres",
        retryable: false,
        constraint,
        cause: error,
      });
    }
    if (code === "40001" || code === "40P01" || code === "55P03") {
      throw new PersistenceError(topMessage, {
        code: "TRANSIENT_CONFLICT",
        driver: "postgres",
        retryable: true,
        constraint,
        cause: error,
      });
    }
    if (code === "57014") {
      throw new PersistenceError(topMessage, {
        code: "UNKNOWN_DB_ERROR",
        driver: "postgres",
        retryable: false,
        constraint,
        cause: error,
      });
    }
    if (
      (code && (code.startsWith("08") || RETRYABLE_PG_CONNECTION_SQLSTATES.has(code) || NETWORK_CONNECTION_CODES.has(code))) ||
      msg.includes("Connection terminated")
    ) {
      throw new PersistenceError(topMessage, {
        code: "CONNECTION_ERROR",
        driver: "postgres",
        retryable: true,
        constraint,
        cause: error,
      });
    }
    if (
      msg.includes("driver has already been destroyed") ||
      msg.includes("Cannot use a pool after calling end")
    ) {
      throw new PersistenceError(topMessage, {
        code: "CONNECTION_ERROR",
        driver: "postgres",
        retryable: false,
        constraint,
        cause: error,
      });
    }
  }

  throw new PersistenceError(topMessage, {
    code: "UNKNOWN_DB_ERROR",
    driver: "postgres",
    retryable: false,
    cause: error,
  });
}
