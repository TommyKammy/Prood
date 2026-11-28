import type {
  ApiErrorResponse,
  CreateProjectRequest,
  CreateTaskRequest,
  EnableDevProjectRequest,
  EnableDevProjectResponse,
  ProjectDevSettingsResponse,
  ProjectListResponse,
  ProjectResponse,
  TaskListResponse,
  TaskResponse,
  TaskSearchResponse,
  UpdateDevProjectSettingsRequest,
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsResponse,
} from "@prood/contracts";
import type { ProjectId, WorkspaceId } from "@prood/domain";

export type ApiCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; messageKey: string };

async function req<T>(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<ApiCallResult<T>> {
  if (typeof fetch === "undefined") {
    return { ok: false, status: 0, code: "NETWORK_ERROR", messageKey: "auth.networkError" };
  }
  try {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    const parsed = (await res.json().catch(() => null)) as (T & ApiErrorResponse) | null;
    if (res.ok && parsed) return { ok: true, data: parsed as T };
    const err = parsed?.error;
    return {
      ok: false,
      status: res.status,
      code: typeof err?.code === "string" ? err.code : "INTERNAL_ERROR",
      messageKey:
        typeof err?.messageKey === "string"
          ? err.messageKey
          : res.status >= 500
            ? "auth.serverError"
            : "error.generic",
    };
  } catch {
    return { ok: false, status: 0, code: "NETWORK_ERROR", messageKey: "auth.networkError" };
  }
}

export const listProjects = (wsId: WorkspaceId) =>
  req<ProjectListResponse>(`/api/v1/workspaces/${wsId}/projects`);

export const createProject = (wsId: WorkspaceId, body: CreateProjectRequest) =>
  req<ProjectResponse>(`/api/v1/workspaces/${wsId}/projects`, "POST", body);

export const listProjectTasks = (prjId: ProjectId) =>
  req<TaskListResponse>(`/api/v1/projects/${prjId}/tasks`);

export const createTask = (prjId: ProjectId, body: CreateTaskRequest) =>
  req<TaskResponse>(`/api/v1/projects/${prjId}/tasks`, "POST", body);

export function searchTasks(
  wsId: WorkspaceId,
  input: { query: string; projectId?: ProjectId; limit?: number },
): Promise<ApiCallResult<TaskSearchResponse>> {
  const q = new URLSearchParams({ q: input.query });
  if (input.projectId) q.set("projectId", input.projectId);
  if (input.limit !== undefined) q.set("limit", String(input.limit));
  return req<TaskSearchResponse>(`/api/v1/workspaces/${wsId}/tasks/search?${q.toString()}`);
}

export const getWorkspaceSettings = (wsId: WorkspaceId) =>
  req<WorkspaceSettingsResponse>(`/api/v1/workspaces/${wsId}/settings`);

export const updateWorkspaceSettings = (
  wsId: WorkspaceId,
  body: UpdateWorkspaceSettingsRequest,
) => req<WorkspaceSettingsResponse>(`/api/v1/workspaces/${wsId}/settings`, "PATCH", body);

export const getProjectDevSettings = (prjId: ProjectId) =>
  req<ProjectDevSettingsResponse>(`/api/v1/projects/${prjId}/dev-settings`);

export const enableDevProject = (prjId: ProjectId, body: EnableDevProjectRequest) =>
  req<EnableDevProjectResponse>(`/api/v1/projects/${prjId}/dev-settings/enable`, "POST", body);

export const updateDevProjectSettings = (
  prjId: ProjectId,
  body: UpdateDevProjectSettingsRequest,
) => req<ProjectDevSettingsResponse>(`/api/v1/projects/${prjId}/dev-settings`, "PATCH", body);
