import type { StatusCategory } from "./access.js";
import type { StatusId, UserId } from "./id.js";

export interface TaskStartStatusInfo {
  id: StatusId;
  category: StatusCategory;
  position: number;
}

export type TaskStartTransitionPlan =
  | { ok: false; reason: "ALREADY_ASSIGNED" | "TASK_COMPLETED" }
  | {
      ok: true;
      nextAssigneeId: UserId;
      nextStatusId: StatusId | null;
      nextCompletedAt: null;
      reopened: boolean;
      changed: boolean;
    };

/** Canonical progression order across workflow status categories. */
export function statusCategoryRank(category: StatusCategory): number {
  switch (category) {
    case "todo":
      return 0;
    case "in_progress":
      return 1;
    case "done":
      return 2;
  }
}

/**
 * Selects the target status when starting (or reopening) a task:
 * prefers the project's configured `startStatusId` if valid (and non-`done` when
 * reopening), otherwise falls back to the first `in_progress` status (or first
 * `todo` status when reopening if no `in_progress` status exists).
 */
export function selectStartTargetStatus(
  statuses: readonly TaskStartStatusInfo[],
  configuredStartStatusId: StatusId | null,
  options?: { forReopen?: boolean },
): TaskStartStatusInfo | null {
  if (configuredStartStatusId) {
    const configured = statuses.find((s) => s.id === configuredStartStatusId);
    if (configured && (!options?.forReopen || configured.category !== "done")) {
      return configured;
    }
  }

  const firstInProgress = statuses.find((s) => s.category === "in_progress");
  if (firstInProgress) {
    return firstInProgress;
  }

  if (options?.forReopen) {
    return statuses.find((s) => s.category === "todo") ?? null;
  }

  return null;
}

/**
 * Pure transition planner for atomic task start (`start_task`):
 * rejects tasks already owned by another user (`ALREADY_ASSIGNED`) or completed
 * tasks unless explicitly reopened (`TASK_COMPLETED`), assigns the actor, never
 * regresses status progress, and clears `completedAt` on explicit reopen.
 */
export function planTaskStartTransition(input: {
  actorUserId: UserId;
  currentAssigneeId: UserId | null;
  currentStatusId: StatusId | null;
  currentCompletedAt: string | null;
  projectStatuses: readonly TaskStartStatusInfo[];
  configuredStartStatusId: StatusId | null;
  reopen: boolean;
}): TaskStartTransitionPlan {
  if (
    input.currentAssigneeId !== null &&
    input.currentAssigneeId !== input.actorUserId
  ) {
    return { ok: false, reason: "ALREADY_ASSIGNED" };
  }

  const currentStatus = input.currentStatusId
    ? (input.projectStatuses.find((s) => s.id === input.currentStatusId) ?? null)
    : null;
  const isCompleted =
    input.currentCompletedAt !== null || currentStatus?.category === "done";

  if (isCompleted && !input.reopen) {
    return { ok: false, reason: "TASK_COMPLETED" };
  }

  if (isCompleted && input.reopen) {
    const target = selectStartTargetStatus(
      input.projectStatuses,
      input.configuredStartStatusId,
      { forReopen: true },
    );
    const nextStatusId = target ? target.id : null;
    return {
      ok: true,
      nextAssigneeId: input.actorUserId,
      nextStatusId,
      nextCompletedAt: null,
      reopened: true,
      changed: true,
    };
  }

  const target = selectStartTargetStatus(
    input.projectStatuses,
    input.configuredStartStatusId,
    { forReopen: false },
  );

  let nextStatusId: StatusId | null;
  if (!target) {
    nextStatusId = currentStatus ? currentStatus.id : null;
  } else if (!currentStatus) {
    nextStatusId = target.id;
  } else if (currentStatus.id === target.id) {
    nextStatusId = currentStatus.id;
  } else {
    const curRank = statusCategoryRank(currentStatus.category);
    const tgtRank = statusCategoryRank(target.category);
    const isBehindTarget =
      curRank < tgtRank ||
      (curRank === tgtRank && currentStatus.position < target.position);
    nextStatusId = isBehindTarget ? target.id : currentStatus.id;
  }

  const changed =
    input.actorUserId !== input.currentAssigneeId ||
    nextStatusId !== input.currentStatusId ||
    input.currentCompletedAt !== null;

  return {
    ok: true,
    nextAssigneeId: input.actorUserId,
    nextStatusId,
    nextCompletedAt: null,
    reopened: false,
    changed,
  };
}
