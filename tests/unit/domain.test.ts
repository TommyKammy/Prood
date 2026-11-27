import { describe, expect, it } from "vitest";
import {
  createMonotonicIdGenerator,
  decodeEntityIdTimestamp,
  DEFAULT_LOCALE,
  formatBranchName,
  formatIssueKey,
  generateEntityId,
  isValidEntityId,
  isValidIssueKeyFormat,
  isValidTaskPublicIdFormat,
  normalizeDevPrefix,
  parseIssueKey,
} from "@prood/domain";

describe("@prood/domain", () => {
  it("defaults locale to English", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("generates canonical prefixed ULIDs and decodes timestamps", () => {
    const fixedTime = Date.UTC(2026, 10, 27, 10, 0, 0, 123);
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const id = generateEntityId("tsk", fixedTime, bytes);

    expect(isValidTaskPublicIdFormat(id)).toBe(true);
    expect(isValidEntityId("tsk", id)).toBe(true);
    expect(isValidEntityId("wks", id)).toBe(false);
    expect(isValidIssueKeyFormat(id)).toBe(false);
    expect(decodeEntityIdTimestamp(id)).toBe(fixedTime);
  });

  it("produces strictly monotonic IDs within the same millisecond and advances on new timestamp", () => {
    let currentMs = 1_795_000_000_000;
    let seed = 10;
    const generator = createMonotonicIdGenerator({
      now: () => currentMs,
      randomBytes: (len) => {
        const buf = new Uint8Array(len);
        buf.fill(seed);
        seed += 1;
        return buf;
      },
    });

    const ids: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      ids.push(generator.next("tsk"));
    }

    expect(new Set(ids).size).toBe(100);
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i - 1]! < ids[i]!).toBe(true);
    }

    currentMs += 1;
    const nextMsId = generator.next("tsk");
    expect(decodeEntityIdTimestamp(nextMsId)).toBe(currentMs);
    expect(ids[ids.length - 1]! < nextMsId).toBe(true);
  });

  it("validates entity IDs per prefix", () => {
    const fixedTime = 1_795_000_000_000;
    const bytes = new Uint8Array(10).fill(7);
    const wksId = generateEntityId("wks", fixedTime, bytes);
    const evtId = generateEntityId("evt", fixedTime, bytes);

    expect(isValidEntityId("wks", wksId)).toBe(true);
    expect(isValidEntityId("tsk", wksId)).toBe(false);
    expect(isValidEntityId("evt", evtId)).toBe(true);
  });

  it("rejects invalid task public IDs (wrong prefix, length, or ambiguous chars)", () => {
    expect(isValidTaskPublicIdFormat("PRD-42")).toBe(false);
    expect(isValidTaskPublicIdFormat("prj_01jf8x9z2k3m4n5p6q7r8s9t0v")).toBe(false);
    expect(isValidTaskPublicIdFormat("tsk_01jf8x9z2k3m4n5p6q7r8s9t0")).toBe(false);
    expect(isValidTaskPublicIdFormat("tsk_01JF8X9Z2K3M4N5P6Q7R8S9T0V")).toBe(false);
    // Crockford Base32 excludes i, l, o, u
    expect(isValidTaskPublicIdFormat("tsk_01if8x9z2k3m4n5p6q7r8s9t0v")).toBe(false);
  });

  it("accepts valid development issue keys and keeps syntax disjoint from public IDs", () => {
    expect(isValidIssueKeyFormat("PRD-1")).toBe(true);
    expect(isValidIssueKeyFormat("ATLAS2-420")).toBe(true);
    expect(isValidIssueKeyFormat("PRD-0")).toBe(false);
    expect(isValidIssueKeyFormat("prd-42")).toBe(false);
    expect(isValidTaskPublicIdFormat("PRD-42")).toBe(false);
  });

  it("rejects 50-bit ULID timestamp overflow and corrupt suffixes, and preserves generator state when RNG fails", () => {
    const overflowId = "tsk_80000000000000000000000000";
    expect(isValidEntityId("tsk", overflowId)).toBe(false);
    expect(() => decodeEntityIdTimestamp(overflowId)).toThrow(RangeError);
    expect(() => decodeEntityIdTimestamp("tsk_zzzzzzzzzzzzzzzzzzzzzzzzzz")).toThrow(
      RangeError,
    );
    expect(() => decodeEntityIdTimestamp("bad_01jf8x9z2k3m4n5p6q7r8s9t0v")).toThrow(
      RangeError,
    );
    expect(() => decodeEntityIdTimestamp("tsk_01jf8x9z2k3m4n5p6q7r8s9t0!")).toThrow(
      RangeError,
    );

    let shouldThrow = true;
    let currentMs = 1_795_000_000_000;
    const gen = createMonotonicIdGenerator({
      now: () => currentMs,
      randomBytes: (len) => {
        if (shouldThrow) {
          throw new Error("entropy unavailable");
        }
        return new Uint8Array(len).fill(42);
      },
    });
    expect(() => gen.next("tsk")).toThrow("entropy unavailable");
    shouldThrow = false;
    // Must generate high-entropy ID normally instead of incrementing stale lastRandom=0
    const recovered = gen.next("tsk");
    expect(recovered.endsWith("0000000000000001")).toBe(false);
    expect(decodeEntityIdTimestamp(recovered)).toBe(currentMs);
  });

  it("normalizes dev prefixes, parses issue keys, and formats keys and branch names", () => {
    expect(normalizeDevPrefix(" prd ")).toBe("PRD");
    expect(normalizeDevPrefix("ab12")).toBe("AB12");
    expect(normalizeDevPrefix("1ab")).toBeNull();
    expect(normalizeDevPrefix("a")).toBeNull();
    expect(normalizeDevPrefix("ABCDEFGHIJK")).toBeNull();
    expect(normalizeDevPrefix("PR-D")).toBeNull();
    expect(normalizeDevPrefix(42)).toBeNull();

    expect(parseIssueKey(" prd-42 ")).toEqual({ prefix: "PRD", number: 42 });
    expect(parseIssueKey("AB1-1")).toEqual({ prefix: "AB1", number: 1 });
    expect(parseIssueKey("PRD-0")).toBeNull();
    expect(parseIssueKey("PRD-")).toBeNull();
    expect(parseIssueKey("tsk_01jf8x9z2k3m4n5p6q7r8s9t0v")).toBeNull();

    expect(formatIssueKey("PRD", 42)).toBe("PRD-42");
    expect(formatBranchName("prd", 42)).toBe("prd-42");

    const insId = generateEntityId("ins", 1_795_000_000_000, new Uint8Array(10).fill(9));
    expect(isValidEntityId("ins", insId)).toBe(true);
    expect(isValidEntityId("tsk", insId)).toBe(false);
  });
});
