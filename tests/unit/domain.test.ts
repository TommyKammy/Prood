import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  isValidIssueKeyFormat,
  isValidTaskPublicIdFormat,
} from "@prood/domain";

describe("@prood/domain", () => {
  it("defaults locale to English", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("accepts canonical lowercase Crockford Base32 task public IDs", () => {
    const validId = "tsk_01jf8x9z2k3m4n5p6q7r8s9t0v";
    expect(isValidTaskPublicIdFormat(validId)).toBe(true);
    expect(isValidIssueKeyFormat(validId)).toBe(false);
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
});
