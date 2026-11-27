import type { WorkspaceRole } from "./identity.js";

export type ProjectVisibility = "workspace" | "private";
export type ProjectRole = "admin" | "member" | "viewer";
export type StatusCategory = "todo" | "in_progress" | "done";

const VALID_PROJECT_KINDS = new Set<string>(["general", "development"]);
const VALID_PROJECT_VISIBILITIES = new Set<string>(["workspace", "private"]);
const VALID_PROJECT_ROLES = new Set<string>(["admin", "member", "viewer"]);
const VALID_STATUS_CATEGORIES = new Set<string>(["todo", "in_progress", "done"]);

export function isValidProjectKind(value: string): value is "general" | "development" {
  return VALID_PROJECT_KINDS.has(value);
}

export function isValidProjectVisibility(value: string): value is ProjectVisibility {
  return VALID_PROJECT_VISIBILITIES.has(value);
}

export function isValidProjectRole(value: string): value is ProjectRole {
  return VALID_PROJECT_ROLES.has(value);
}

export function isValidStatusCategory(value: string): value is StatusCategory {
  return VALID_STATUS_CATEGORIES.has(value);
}

/**
 * Computes the effective role an actor holds on a project.
 * Cross-workspace users always receive `null`, workspace admins always hold `admin`,
 * explicit project members hold at most their project role (capped at `viewer` for
 * workspace viewers), and open workspace projects grant the actor's workspace role.
 */
export function resolveEffectiveProjectRole(input: {
  workspaceRole: WorkspaceRole | null;
  projectVisibility: ProjectVisibility;
  projectMembershipRole: ProjectRole | null;
}): ProjectRole | null {
  if (!input.workspaceRole) {
    return null;
  }
  if (input.workspaceRole === "admin") {
    return "admin";
  }
  if (input.projectMembershipRole !== null) {
    return input.workspaceRole === "viewer"
      ? "viewer"
      : input.projectMembershipRole;
  }
  if (input.projectVisibility === "workspace") {
    return input.workspaceRole;
  }
  return null;
}

export function canReadProject(role: ProjectRole | null): boolean {
  return role !== null;
}

export function canWriteProjectTasks(role: ProjectRole | null): boolean {
  return role === "admin" || role === "member";
}

export function canManageProject(role: ProjectRole | null): boolean {
  return role === "admin";
}
