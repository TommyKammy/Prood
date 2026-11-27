import type { LocaleCode, WorkspaceId } from "@prood/domain";

export interface WorkspaceRecord {
  id: WorkspaceId;
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSettingsRecord {
  workspaceId: WorkspaceId;
  defaultLocale: LocaleCode;
  devProjectsEnabled: boolean;
  updatedAt: string;
}

export interface CreateWorkspaceInput {
  id: WorkspaceId;
  slug: string;
  name: string;
  createdAt: string;
}

export interface UpsertWorkspaceSettingsInput {
  workspaceId: WorkspaceId;
  defaultLocale: LocaleCode;
  devProjectsEnabled: boolean;
  updatedAt: string;
}

export interface WorkspaceRepository {
  create(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  findById(id: WorkspaceId): Promise<WorkspaceRecord | null>;
  findBySlug(slug: string): Promise<WorkspaceRecord | null>;
  updateName(
    id: WorkspaceId,
    name: string,
    updatedAt: string,
  ): Promise<WorkspaceRecord | null>;
}

export interface WorkspaceSettingsRepository {
  upsert(input: UpsertWorkspaceSettingsInput): Promise<WorkspaceSettingsRecord>;
  findByWorkspaceId(workspaceId: WorkspaceId): Promise<WorkspaceSettingsRecord | null>;
}

export interface TransactionRepositories {
  readonly workspaces: WorkspaceRepository;
  readonly workspaceSettings: WorkspaceSettingsRepository;
}

/**
 * Executes a callback inside a single atomic DB transaction bound to the
 * passed repositories. Implementations handle driver-specific locking and
 * bounded transient conflict retries.
 */
export interface UnitOfWork {
  run<T>(fn: (repos: TransactionRepositories) => Promise<T>): Promise<T>;
}
