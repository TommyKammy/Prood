import { describe, expect, it } from "vitest";
import {
  canonicalizeIdempotencyPayload,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  normalizeIdempotencyKey,
} from "@prood/domain";

describe("@prood/domain idempotency helpers", () => {
  it("normalizes valid keys and rejects empty, overlong, or control-character keys", () => {
    expect(normalizeIdempotencyKey("  req-123  ")).toBe("req-123");
    expect(normalizeIdempotencyKey("a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH))).toBe(
      "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH),
    );
    expect(normalizeIdempotencyKey("")).toBeNull();
    expect(normalizeIdempotencyKey("   ")).toBeNull();
    expect(
      normalizeIdempotencyKey("a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)),
    ).toBeNull();
    expect(normalizeIdempotencyKey("req\n123")).toBeNull();
    expect(normalizeIdempotencyKey("req\r123")).toBeNull();
    expect(normalizeIdempotencyKey("req\x00123")).toBeNull();
  });

  it("produces deterministic key-sorted canonical JSON regardless of key order or undefined properties", () => {
    const a = canonicalizeIdempotencyPayload({
      z: 1,
      a: { y: "hello", x: null },
      optional: undefined,
      arr: [{ b: 2, a: 1 }, true],
    });
    const b = canonicalizeIdempotencyPayload({
      arr: [{ a: 1, b: 2 }, true],
      a: { x: null, y: "hello" },
      z: 1,
    });
    expect(a).toBe(b);

    const withNullStatus = canonicalizeIdempotencyPayload({ statusId: null });
    const withDefaultStatus = canonicalizeIdempotencyPayload({
      statusId: "__default__",
    });
    expect(withNullStatus).not.toBe(withDefaultStatus);
  });
});
