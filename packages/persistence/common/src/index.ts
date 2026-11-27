import type { DatabaseHealthPort } from "@prood/application";
import type { DbDriverKind } from "@prood/contracts";

export * from "./errors.js";
export * from "./migrations.js";
export * from "./repositories.js";
export * from "./retry.js";
export * from "./schema.js";

export interface SmokeProbeResult {
  driver: DbDriverKind;
  persistedParentValue: string;
  persistedChildId: string;
  foreignKeyEnforced: boolean;
}

/**
 * Common persistence smoke adapter implemented by both SQLite and PostgreSQL backends.
 */
export interface DbSmokeAdapter extends DatabaseHealthPort {
  runPersistenceRoundTripCheck(
    probeKey: string,
    probeValue: string,
  ): Promise<SmokeProbeResult>;
}
