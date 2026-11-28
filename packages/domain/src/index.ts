import { isValidEntityId, type TaskPublicId } from "./id.js";

export * from "./access.js";
export * from "./dev-projects.js";
export * from "./events.js";
export * from "./id.js";
export * from "./idempotency.js";
export * from "./identity.js";
export * from "./task-start.js";

export type LocaleCode = "en" | "ja" | (string & {});

export const DEFAULT_LOCALE = "en" as const;

export type ProjectKind = "general" | "development";

const ISSUE_KEY_REGEX = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/;

/**
 * Validates that a string matches the canonical task public ID format:
 * `tsk_` followed by 26 lowercase Crockford Base32 characters.
 */
export function isValidTaskPublicIdFormat(value: string): value is TaskPublicId {
  return isValidEntityId("tsk", value);
}

/**
 * Validates that a string matches a development project issue key
 * such as `PRD-42`. Mutually exclusive with `tsk_...` public IDs.
 */
export function isValidIssueKeyFormat(value: string): boolean {
  return ISSUE_KEY_REGEX.test(value);
}
