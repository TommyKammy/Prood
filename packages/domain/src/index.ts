export type LocaleCode = "en" | "ja" | (string & {});

export const DEFAULT_LOCALE = "en" as const;

export type PublicEntityPrefix = "tsk" | "prj" | "wks" | "usr" | "sts" | "evt";

export type EntityId<P extends PublicEntityPrefix> = `${P}_${string}`;

export type TaskPublicId = EntityId<"tsk">;

export type ProjectKind = "general" | "development";

const TASK_PUBLIC_ID_REGEX = /^tsk_[0-9a-hjkmnp-tv-z]{26}$/;
const ISSUE_KEY_REGEX = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/;

/**
 * Validates that a string matches the canonical task public ID format:
 * `tsk_` followed by 26 lowercase Crockford Base32 characters.
 */
export function isValidTaskPublicIdFormat(value: string): value is TaskPublicId {
  return TASK_PUBLIC_ID_REGEX.test(value);
}

/**
 * Validates that a string matches a development project issue key
 * such as `PRD-42`. Mutually exclusive with `tsk_...` public IDs.
 */
export function isValidIssueKeyFormat(value: string): boolean {
  return ISSUE_KEY_REGEX.test(value);
}
