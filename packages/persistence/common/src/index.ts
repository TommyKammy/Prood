import type { DatabaseHealthPort } from "@prood/application";
import type { DbDriverKind } from "@prood/contracts";

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
