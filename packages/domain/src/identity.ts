export type WorkspaceRole = "admin" | "member" | "viewer";

const VALID_ROLES = new Set<string>(["admin", "member", "viewer"]);

export function isValidWorkspaceRole(value: string): value is WorkspaceRole {
  return VALID_ROLES.has(value);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
