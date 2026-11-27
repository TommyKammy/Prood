/** Stored prefixes: an uppercase ASCII letter followed by 1–9 uppercase letters or digits. */
export const DEV_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

/** Accepted issue key syntax (case-insensitive on input; canonical uppercase on output). */
export const ISSUE_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]{0,8})$/;

/**
 * Upper bound on tasks backfilled synchronously when enabling a project
 * as a development project, bounding transaction lock duration.
 */
export const DEV_PROJECT_ENABLE_MAX_TASKS = 20_000;

/** Trims and uppercases a prefix candidate; returns null if invalid. */
export function normalizeDevPrefix(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const normalized = input.trim().toUpperCase();
  return DEV_PREFIX_PATTERN.test(normalized) ? normalized : null;
}

/** Parses an issue key such as `PRD-42` or `prd-42`; returns null if malformed. */
export function parseIssueKey(
  input: unknown,
): { prefix: string; number: number } | null {
  if (typeof input !== "string") {
    return null;
  }
  const match = ISSUE_KEY_PATTERN.exec(input.trim());
  if (!match) {
    return null;
  }
  return {
    prefix: match[1]!.toUpperCase(),
    number: Number(match[2]),
  };
}

/** Formats the display issue key from the namespace's current prefix and number. */
export function formatIssueKey(prefix: string, issueNumber: number): string {
  return `${prefix}-${issueNumber}`;
}

/** Formats the immutable Git branch suggestion from the fixed branch prefix and number. */
export function formatBranchName(
  branchPrefix: string,
  issueNumber: number,
): string {
  return `${branchPrefix}-${issueNumber}`;
}
