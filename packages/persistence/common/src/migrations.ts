import type { Kysely } from "kysely";
import type { DatabaseHealthPort, UnitOfWork } from "@prood/application";
import type { ProodDatabase } from "./schema.js";

export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export interface MigrationRunOptions {
  targetVersion?: number;
}

export interface MigrationRunResult {
  appliedVersions: number[];
  currentVersion: number;
}

export interface DatabaseClient extends DatabaseHealthPort {
  readonly uow: UnitOfWork;
  migrate(options?: MigrationRunOptions): Promise<MigrationRunResult>;
  getAppliedMigrationVersions(): Promise<number[]>;
  close(): Promise<void>;
}

export interface KyselyBackedDatabaseClient extends DatabaseClient {
  readonly kysely: Kysely<ProodDatabase>;
}
