import type { LocaleCode } from "@prood/domain";

export const CONTRACT_VERSION = 1 as const;

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "INTERNAL_ERROR";

export type DbDriverKind = "postgres" | "sqlite";

export interface HealthResponse {
  contractVersion: typeof CONTRACT_VERSION;
  status: "ok";
  dbDriver: DbDriverKind;
  locale: LocaleCode;
  timestamp: string;
}
