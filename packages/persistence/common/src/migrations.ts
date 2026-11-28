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

export const automationMigration: MigrationDefinition = {
  version: 8,
  name: "0008_project_automation",
  statements: [
    "ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
    "CREATE TABLE automation_rules(project TEXT NOT NULL REFERENCES projects(id),rule TEXT NOT NULL,revision INTEGER NOT NULL,delegation INTEGER NOT NULL,actor TEXT NOT NULL REFERENCES users(id),enabled INTEGER NOT NULL,definition TEXT NOT NULL,PRIMARY KEY(project,rule))",
    "CREATE TABLE automation_deliveries(workspace TEXT NOT NULL REFERENCES workspaces(id),project TEXT NOT NULL REFERENCES projects(id),event TEXT NOT NULL REFERENCES outbox_events(event_id),rule TEXT NOT NULL,envelope TEXT NOT NULL,token TEXT,expires TEXT,run TEXT,reason TEXT,PRIMARY KEY(event,rule),UNIQUE(workspace,run))",
    "CREATE TABLE automation_checks(event TEXT NOT NULL,rule TEXT NOT NULL,run TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(event,rule,run,status),FOREIGN KEY(event,rule) REFERENCES automation_deliveries(event,rule))",
    "CREATE INDEX automation_pending ON automation_deliveries(workspace,expires,event,rule) WHERE run IS NULL AND reason IS NULL",
  ],
};

export const effectMigration: MigrationDefinition = {
  version: 9,
  name: "0009_automation_operation_receipts",
  statements: [
    "CREATE TABLE automation_receipts(workspace TEXT NOT NULL, run TEXT NOT NULL, event TEXT NOT NULL, rule TEXT NOT NULL, result TEXT NOT NULL, decision TEXT, PRIMARY KEY(workspace,run), UNIQUE(event,rule), FOREIGN KEY(event,rule) REFERENCES automation_deliveries(event,rule))",
  ],
};
