import type { DatabaseHealthPort, UnitOfWork } from "@prood/application";

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
