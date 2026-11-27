export const CROCKFORD_BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

export type PublicEntityPrefix =
  | "tsk"
  | "prj"
  | "wks"
  | "usr"
  | "sts"
  | "evt"
  | "mbr"
  | "out";

export type EntityId<P extends PublicEntityPrefix> = `${P}_${string}`;

export type TaskPublicId = EntityId<"tsk">;
export type WorkspaceId = EntityId<"wks">;
export type UserId = EntityId<"usr">;
export type MembershipId = EntityId<"mbr">;

const TIMESTAMP_LENGTH = 10;
const RANDOM_LENGTH = 16;
const ULID_LENGTH = TIMESTAMP_LENGTH + RANDOM_LENGTH;
const MAX_TIMESTAMP_MS = 0xffff_ffff_ffff; // 2^48 - 1
const MAX_80BIT_RANDOM = (1n << 80n) - 1n;

const BASE32_LOOKUP = new Map<string, bigint>(
  Array.from(CROCKFORD_BASE32).map((ch, idx) => [ch, BigInt(idx)]),
);

function encodeBigIntBase32(value: bigint, length: number): string {
  const chars = new Array<string>(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    chars[i] = CROCKFORD_BASE32[Number(remaining & 31n)]!;
    remaining >>= 5n;
  }
  return chars.join("");
}

function bytesToBigInt80(bytes: Uint8Array): bigint {
  if (bytes.length < 10) {
    throw new RangeError(`Expected at least 10 random bytes, got ${bytes.length}`);
  }
  let value = 0n;
  for (let i = 0; i < 10; i += 1) {
    value = (value << 8n) | BigInt(bytes[i]!);
  }
  return value;
}

/**
 * Encodes a 48-bit Unix millisecond timestamp into 10 lowercase Crockford Base32 chars.
 */
export function encodeBase32Timestamp(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIMESTAMP_MS) {
    throw new RangeError(`Timestamp out of 48-bit range: ${ms}`);
  }
  return encodeBigIntBase32(BigInt(ms), TIMESTAMP_LENGTH);
}

/**
 * Encodes the first 10 bytes (80 bits) into 16 lowercase Crockford Base32 chars.
 */
export function encodeBase32Random80(bytes: Uint8Array): string {
  return encodeBigIntBase32(bytesToBigInt80(bytes), RANDOM_LENGTH);
}

/**
 * Generates a prefixed lowercase ULID entity ID from explicit timestamp and random bytes.
 */
export function generateEntityId<P extends PublicEntityPrefix>(
  prefix: P,
  timestampMs: number,
  randomBytes: Uint8Array,
): EntityId<P> {
  const ts = encodeBase32Timestamp(timestampMs);
  const rand = encodeBase32Random80(randomBytes);
  return `${prefix}_${ts}${rand}`;
}

export interface MonotonicIdGeneratorDeps {
  now(): number;
  randomBytes(length: number): Uint8Array;
}

export interface MonotonicIdGenerator {
  next<P extends PublicEntityPrefix>(prefix: P): EntityId<P>;
}

/**
 * Creates a monotonic ULID entity ID generator.
 * Within the same millisecond, the 80-bit random component increments by 1
 * so generated IDs sort strictly in creation order.
 */
export function createMonotonicIdGenerator(
  deps: MonotonicIdGeneratorDeps,
): MonotonicIdGenerator {
  let lastTime = -1;
  let lastRandom = 0n;

  return {
    next<P extends PublicEntityPrefix>(prefix: P): EntityId<P> {
      const nowMs = deps.now();
      if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIMESTAMP_MS) {
        throw new RangeError(`Timestamp out of 48-bit range: ${nowMs}`);
      }

      if (nowMs <= lastTime) {
        if (lastRandom >= MAX_80BIT_RANDOM) {
          throw new Error("ULID 80-bit random component overflow within millisecond");
        }
        lastRandom += 1n;
      } else {
        lastTime = nowMs;
        lastRandom = bytesToBigInt80(deps.randomBytes(10));
      }

      const ts = encodeBigIntBase32(BigInt(lastTime), TIMESTAMP_LENGTH);
      const rand = encodeBigIntBase32(lastRandom, RANDOM_LENGTH);
      return `${prefix}_${ts}${rand}`;
    },
  };
}

/**
 * Validates that a string matches `<prefix>_<26 lowercase Crockford Base32 chars>`.
 */
export function isValidEntityId<P extends PublicEntityPrefix>(
  prefix: P,
  value: string,
): value is EntityId<P> {
  const expectedPrefix = `${prefix}_`;
  if (!value.startsWith(expectedPrefix)) {
    return false;
  }
  const suffix = value.slice(expectedPrefix.length);
  if (suffix.length !== ULID_LENGTH) {
    return false;
  }
  for (let i = 0; i < suffix.length; i += 1) {
    if (!BASE32_LOOKUP.has(suffix[i]!)) {
      return false;
    }
  }
  return true;
}

/**
 * Decodes the 48-bit Unix millisecond timestamp from a valid prefixed entity ID.
 */
export function decodeEntityIdTimestamp(id: string): number {
  const sepIdx = id.indexOf("_");
  if (sepIdx <= 0) {
    throw new RangeError(`Invalid entity ID format: ${id}`);
  }
  const suffix = id.slice(sepIdx + 1);
  if (suffix.length !== ULID_LENGTH) {
    throw new RangeError(`Invalid entity ID length: ${id}`);
  }
  let ts = 0n;
  for (let i = 0; i < TIMESTAMP_LENGTH; i += 1) {
    const digit = BASE32_LOOKUP.get(suffix[i]!);
    if (digit === undefined) {
      throw new RangeError(`Invalid Base32 character in entity ID: ${id}`);
    }
    ts = (ts << 5n) | digit;
  }
  return Number(ts);
}
