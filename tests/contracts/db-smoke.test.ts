import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DbDriverKind } from "@prood/contracts";
import type { DbSmokeAdapter } from "@prood/persistence-common";
import { createPostgresSmokeAdapter } from "@prood/persistence-postgres";
import { createSqliteSmokeAdapter } from "@prood/persistence-sqlite";

const targetDb = process.env.PROOD_TEST_DB as DbDriverKind | undefined;
if (targetDb !== "sqlite" && targetDb !== "postgres") {
  throw new Error(
    `PROOD_TEST_DB must be "sqlite" or "postgres" (received: ${String(targetDb)})`,
  );
}

let tempDir: string | undefined;

function createTargetAdapter(): DbSmokeAdapter {
  if (targetDb === "sqlite") {
    tempDir = mkdtempSync(join(tmpdir(), "prood-sqlite-smoke-"));
    return createSqliteSmokeAdapter(join(tempDir, "smoke.sqlite"));
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set when PROOD_TEST_DB=postgres");
  }
  return createPostgresSmokeAdapter(databaseUrl);
}

const adapter = createTargetAdapter();

afterAll(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe(`DB contract smoke (${targetDb})`, () => {
  it("responds to health ping", async () => {
    expect(adapter.driver).toBe(targetDb);
    await expect(adapter.ping()).resolves.toEqual({ ok: true });
  });

  it("persists across reconnect / separate session and enforces foreign keys", async () => {
    const probeKey = `smoke_${targetDb}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const probeValue = "prood-persistence-ok";

    const result = await adapter.runPersistenceRoundTripCheck(probeKey, probeValue);

    expect(result).toEqual({
      driver: targetDb,
      persistedParentValue: probeValue,
      persistedChildId: `${probeKey}:child`,
      foreignKeyEnforced: true,
    });
  });
});
