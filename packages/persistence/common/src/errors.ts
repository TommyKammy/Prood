import type { DbDriverKind } from "@prood/contracts";

export type PersistenceErrorCode =
  | "UNIQUE_VIOLATION"
  | "FOREIGN_KEY_VIOLATION"
  | "NOT_NULL_VIOLATION"
  | "CHECK_VIOLATION"
  | "TRANSIENT_CONFLICT"
  | "CONNECTION_ERROR"
  | "UNKNOWN_DB_ERROR";

export interface PersistenceErrorOptions {
  code: PersistenceErrorCode;
  driver: DbDriverKind;
  retryable: boolean;
  constraint?: string;
  cause?: unknown;
}

/**
 * Driver-independent persistence error raised by SQLite and PostgreSQL adapters.
 */
export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly driver: DbDriverKind;
  readonly retryable: boolean;
  readonly constraint?: string;

  constructor(message: string, options: PersistenceErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "PersistenceError";
    this.code = options.code;
    this.driver = options.driver;
    this.retryable = options.retryable;
    if (options.constraint !== undefined) {
      this.constraint = options.constraint;
    }
  }
}

export function isPersistenceError(
  value: unknown,
  code?: PersistenceErrorCode,
): value is PersistenceError {
  if (!(value instanceof PersistenceError)) {
    return false;
  }
  return code === undefined ? true : value.code === code;
}
