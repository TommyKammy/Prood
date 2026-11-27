import type { WorkspaceMembershipSummary } from "@prood/contracts";
import type {
  LocaleCode,
  MembershipId,
  UserId,
  WorkspaceId,
  WorkspaceRole,
} from "@prood/domain";

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

export interface UserRecord {
  id: UserId;
  email: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthIdentityRecord {
  authProvider: string;
  authSubject: string;
  userId: UserId;
  createdAt: string;
}

export interface WorkspaceMembershipRecord {
  id: MembershipId;
  workspaceId: WorkspaceId;
  userId: UserId;
  role: WorkspaceRole;
  createdAt: string;
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

export interface CreateUserInput {
  id: UserId;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface LinkAuthIdentityInput {
  authProvider: string;
  authSubject: string;
  userId: UserId;
  createdAt: string;
}

export interface CreateMembershipInput {
  id: MembershipId;
  workspaceId: WorkspaceId;
  userId: UserId;
  role: WorkspaceRole;
  createdAt: string;
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

export interface UserRepository {
  findById(id: UserId): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findByAuthIdentity(
    authProvider: string,
    authSubject: string,
  ): Promise<UserRecord | null>;
  create(input: CreateUserInput): Promise<UserRecord>;
  linkAuthIdentity(input: LinkAuthIdentityInput): Promise<AuthIdentityRecord>;
}

export interface WorkspaceMembershipRepository {
  create(input: CreateMembershipInput): Promise<WorkspaceMembershipRecord>;
  findByWorkspaceAndUser(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<WorkspaceMembershipRecord | null>;
  listSummariesForUser(userId: UserId): Promise<WorkspaceMembershipSummary[]>;
}

export interface TransactionRepositories {
  readonly workspaces: WorkspaceRepository;
  readonly workspaceSettings: WorkspaceSettingsRepository;
  readonly users: UserRepository;
  readonly memberships: WorkspaceMembershipRepository;
}

/**
 * Executes a callback inside a single atomic DB transaction bound to the
 * passed repositories. Implementations handle driver-specific locking and
 * bounded transient conflict retries.
 */
export interface UnitOfWork {
  run<T>(fn: (repos: TransactionRepositories) => Promise<T>): Promise<T>;
}
