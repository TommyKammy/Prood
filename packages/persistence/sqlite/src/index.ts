import type { DbSmokeAdapter, SmokeProbeResult } from "@prood/persistence-common";
import { openSqliteConnection } from "./database.js";

export * from "./database.js";
export * from "./errors.js";
export * from "./migrations.js";

export function createSqliteSmokeAdapter(filePath: string): DbSmokeAdapter {
  return {
    driver: "sqlite",

    async ping(): Promise<{ ok: true }> {
      const db = openSqliteConnection(filePath);
      try {
        const row = db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
        if (row?.ok !== 1) {
          throw new Error("SQLite health ping failed");
        }
        return { ok: true };
      } finally {
        db.close();
      }
    },

    async runPersistenceRoundTripCheck(
      probeKey: string,
      probeValue: string,
    ): Promise<SmokeProbeResult> {
      const childId = `${probeKey}:child`;
      const db1 = openSqliteConnection(filePath);
      try {
        db1.exec(`
          CREATE TABLE IF NOT EXISTS prood_smoke_parents (
            id TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS prood_smoke_children (
            id TEXT PRIMARY KEY,
            parent_id TEXT NOT NULL REFERENCES prood_smoke_parents(id)
          );
        `);

        const insertBoth = db1.transaction(() => {
          db1
            .prepare("INSERT INTO prood_smoke_parents (id, value) VALUES (?, ?)")
            .run(probeKey, probeValue);
          db1
            .prepare("INSERT INTO prood_smoke_children (id, parent_id) VALUES (?, ?)")
            .run(childId, probeKey);
        });
        insertBoth();
      } finally {
        db1.close();
      }

      const db2 = openSqliteConnection(filePath);
      try {
        const parentRow = db2
          .prepare("SELECT value FROM prood_smoke_parents WHERE id = ?")
          .get(probeKey) as { value: string } | undefined;
        const childRow = db2
          .prepare("SELECT id FROM prood_smoke_children WHERE parent_id = ?")
          .get(probeKey) as { id: string } | undefined;

        if (!parentRow || !childRow) {
          throw new Error("Persisted smoke rows were not found after SQLite reconnect");
        }

        let foreignKeyEnforced = false;
        try {
          db2
            .prepare("INSERT INTO prood_smoke_children (id, parent_id) VALUES (?, ?)")
            .run(`${probeKey}:orphan`, `${probeKey}:missing-parent`);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (
            code === "SQLITE_CONSTRAINT_FOREIGNKEY" ||
            (error instanceof Error && error.message.includes("FOREIGN KEY constraint failed"))
          ) {
            foreignKeyEnforced = true;
          } else {
            throw error;
          }
        }

        return {
          driver: "sqlite",
          persistedParentValue: parentRow.value,
          persistedChildId: childRow.id,
          foreignKeyEnforced,
        };
      } finally {
        db2.close();
      }
    },
  };
}
