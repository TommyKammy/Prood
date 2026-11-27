import { Client } from "pg";
import type { DbSmokeAdapter, SmokeProbeResult } from "@prood/persistence-common";

export function createPostgresSmokeAdapter(connectionString: string): DbSmokeAdapter {
  return {
    driver: "postgres",

    async ping(): Promise<{ ok: true }> {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        const result = await client.query<{ ok: number }>("SELECT 1 AS ok");
        if (result.rows[0]?.ok !== 1) {
          throw new Error("PostgreSQL health ping failed");
        }
        return { ok: true };
      } finally {
        await client.end();
      }
    },

    async runPersistenceRoundTripCheck(
      probeKey: string,
      probeValue: string,
    ): Promise<SmokeProbeResult> {
      const childId = `${probeKey}:child`;
      const session1 = new Client({ connectionString });
      await session1.connect();
      try {
        await session1.query(`
          CREATE TABLE IF NOT EXISTS prood_smoke_parents (
            id TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS prood_smoke_children (
            id TEXT PRIMARY KEY,
            parent_id TEXT NOT NULL REFERENCES prood_smoke_parents(id)
          );
        `);

        await session1.query("BEGIN");
        try {
          await session1.query(
            "INSERT INTO prood_smoke_parents (id, value) VALUES ($1, $2)",
            [probeKey, probeValue],
          );
          await session1.query(
            "INSERT INTO prood_smoke_children (id, parent_id) VALUES ($1, $2)",
            [childId, probeKey],
          );
          await session1.query("COMMIT");
        } catch (error) {
          await session1.query("ROLLBACK");
          throw error;
        }
      } finally {
        await session1.end();
      }

      const session2 = new Client({ connectionString });
      await session2.connect();
      try {
        const parentRes = await session2.query<{ value: string }>(
          "SELECT value FROM prood_smoke_parents WHERE id = $1",
          [probeKey],
        );
        const childRes = await session2.query<{ id: string }>(
          "SELECT id FROM prood_smoke_children WHERE parent_id = $1",
          [probeKey],
        );

        const parentRow = parentRes.rows[0];
        const childRow = childRes.rows[0];
        if (!parentRow || !childRow) {
          throw new Error("Persisted smoke rows were not found in separate PostgreSQL session");
        }

        let foreignKeyEnforced = false;
        try {
          await session2.query(
            "INSERT INTO prood_smoke_children (id, parent_id) VALUES ($1, $2)",
            [`${probeKey}:orphan`, `${probeKey}:missing-parent`],
          );
        } catch (error) {
          if ((error as { code?: string }).code === "23503") {
            foreignKeyEnforced = true;
          } else {
            throw error;
          }
        }

        await session2.query("DELETE FROM prood_smoke_children WHERE id = $1", [childId]);
        await session2.query("DELETE FROM prood_smoke_parents WHERE id = $1", [probeKey]);

        return {
          driver: "postgres",
          persistedParentValue: parentRow.value,
          persistedChildId: childRow.id,
          foreignKeyEnforced,
        };
      } finally {
        await session2.end();
      }
    },
  };
}
