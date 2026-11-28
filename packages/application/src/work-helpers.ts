import type { TaskDto } from "@prood/contracts";
import {
  formatBranchName,
  formatIssueKey,
  resolveEffectiveProjectRole,
  type ProjectId,
  type ProjectRole,
  type UserId,
} from "@prood/domain";
import type {
  ProjectRecord,
  TaskIssueKeyView,
  TaskRecord,
  TransactionRepositories,
} from "./persistence.js";

export const MAX_PARENT_HOPS = 16;

/**
 * Resolves a user's effective role on a project, combining workspace and
 * project-level memberships.
 */
export async function resolveActorProjectRole(
  repos: TransactionRepositories,
  userId: UserId | null,
  project: ProjectRecord,
): Promise<ProjectRole | null> {
  if (!userId) {
    return null;
  }
  const workspaceMembership = await repos.memberships.findByWorkspaceAndUser(
    project.workspaceId,
    userId,
  );
  if (!workspaceMembership) {
    return null;
  }
  const projectMembership = await repos.projects.findMembership(
    project.id,
    userId,
  );
  return resolveEffectiveProjectRole({
    workspaceRole: workspaceMembership.role,
    projectVisibility: project.visibility,
    projectMembershipRole: projectMembership?.role ?? null,
  });
}

/**
 * Resolves the effective project of a task, walking inherited parent links up
 * to `MAX_PARENT_HOPS`.
 */
export async function resolveTaskEffectiveProject(
  repos: TransactionRepositories,
  task: TaskRecord,
): Promise<{ project: ProjectRecord; depth: number } | null> {
  let current: TaskRecord | null = task;
  const visited = new Set<string>();
  for (let hop = 0; hop < MAX_PARENT_HOPS && current; hop += 1) {
    if (current.projectId) {
      const project = await repos.projects.findById(current.projectId);
      if (!project || project.workspaceId !== task.workspaceId) {
        return null;
      }
      return { project, depth: hop };
    }
    if (!current.parentTaskId || visited.has(current.parentTaskId)) {
      return null;
    }
    visited.add(current.id);
    const parent = await repos.tasks.findById(current.parentTaskId);
    if (!parent || parent.workspaceId !== task.workspaceId) {
      return null;
    }
    current = parent;
  }
  return null;
}

/**
 * Maps a persisted task row and resolved context fields into a public `TaskDto`.
 */
export function toTaskDto(
  task: TaskRecord,
  effectiveProjectId: ProjectId,
  issueKeyView: TaskIssueKeyView | null = null,
  showIssueKey = true,
  assigneeDisplayName?: string | null,
): TaskDto {
  const visibleKey = showIssueKey ? issueKeyView : null;
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    effectiveProjectId,
    parentTaskId: task.parentTaskId,
    statusId: task.statusId,
    issueKey: visibleKey
      ? formatIssueKey(visibleKey.currentPrefix, visibleKey.issueNumber)
      : null,
    branchName: visibleKey
      ? formatBranchName(visibleKey.branchPrefix, visibleKey.issueNumber)
      : null,
    title: task.title,
    description: task.description,
    assigneeId: task.assigneeId,
    ...(assigneeDisplayName !== undefined ? { assigneeDisplayName } : {}),
    createdBy: task.createdBy,
    dueOn: task.dueOn,
    completedAt: task.completedAt,
    position: task.position,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * Loads display names for any non-null `assigneeId` values inside a transaction.
 */
export async function resolveAssigneeDisplayNames(
  repos: TransactionRepositories,
  tasks: readonly Pick<TaskRecord, "assigneeId">[],
): Promise<Map<UserId, string>> {
  const assigneeIds = tasks
    .map((task) => task.assigneeId)
    .filter((id): id is UserId => id !== null);
  if (assigneeIds.length === 0) {
    return new Map();
  }
  const usersById = await repos.users.findByIds(assigneeIds);
  const displayNames = new Map<UserId, string>();
  for (const [id, user] of usersById) {
    displayNames.set(id, user.displayName);
  }
  return displayNames;
}
