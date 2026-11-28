export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

/**
 * Normalizes an idempotency key by trimming surrounding whitespace and
 * rejecting empty strings, overlong strings (> 128 chars), or ASCII control characters.
 */
export function normalizeIdempotencyKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    CONTROL_CHAR_REGEX.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function canonicalizeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const prop = record[key];
      if (prop === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${canonicalizeValue(prop)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return "null";
}

/**
 * Produces a deterministic key-sorted canonical JSON representation of an
 * idempotent request payload (zero runtime dependencies, Cloudflare-portable).
 */
export function canonicalizeIdempotencyPayload(value: unknown): string {
  return canonicalizeValue(value);
}
