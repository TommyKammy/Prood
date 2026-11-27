import {
  createMonotonicIdGenerator,
  type EntityId,
  type MonotonicIdGenerator,
  type PublicEntityPrefix,
} from "@prood/domain";

export type IdGenerator = MonotonicIdGenerator;
export type { EntityId, PublicEntityPrefix };

/**
 * Creates a system ID generator backed by Web Standard `crypto.getRandomValues`
 * so it remains portable across Node.js and Cloudflare Workers.
 */
export function createSystemIdGenerator(): IdGenerator {
  return createMonotonicIdGenerator({
    now: () => Date.now(),
    randomBytes: (length: number) => {
      const bytes = new Uint8Array(length);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    },
  });
}
