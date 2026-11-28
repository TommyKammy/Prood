import { describe, expect, it } from "vitest";
import {
  planTaskStartTransition,
  selectStartTargetStatus,
  type StatusId,
  type TaskStartStatusInfo,
  type UserId,
} from "@prood/domain";

const STS_TODO = "sts_01jf8x9z2k3m4n5p6q7r8s9t0a" as StatusId;
const STS_IN_PROGRESS = "sts_01jf8x9z2k3m4n5p6q7r8s9t0b" as StatusId;
const STS_IN_REVIEW = "sts_01jf8x9z2k3m4n5p6q7r8s9t0c" as StatusId;
const STS_DONE = "sts_01jf8x9z2k3m4n5p6q7r8s9t0d" as StatusId;

const USR_A = "usr_01jf8x9z2k3m4n5p6q7r8s9t01" as UserId;
const USR_B = "usr_01jf8x9z2k3m4n5p6q7r8s9t02" as UserId;

const STATUSES: TaskStartStatusInfo[] = [
  { id: STS_TODO, category: "todo", position: 0 },
  { id: STS_IN_PROGRESS, category: "in_progress", position: 1 },
  { id: STS_IN_REVIEW, category: "in_progress", position: 2 },
  { id: STS_DONE, category: "done", position: 3 },
];

describe("@prood/domain planTaskStartTransition & selectStartTargetStatus", () => {
  it("assigns actor and advances from todo to configured start status or first in_progress", () => {
    expect(
      planTaskStartTransition({
        actorUserId: USR_A,
        currentAssigneeId: null,
        currentStatusId: STS_TODO,
        currentCompletedAt: null,
        projectStatuses: STATUSES,
        configuredStartStatusId: STS_IN_PROGRESS,
        reopen: false,
      }),
    ).toEqual({
      ok: true,
      nextAssigneeId: USR_A,
      nextStatusId: STS_IN_PROGRESS,
      nextCompletedAt: null,
      reopened: false,
      changed: true,
    });

    expect(
      planTaskStartTransition({
        actorUserId: USR_A,
        currentAssigneeId: null,
        currentStatusId: null,
        currentCompletedAt: null,
        projectStatuses: STATUSES,
        configuredStartStatusId: null,
        reopen: false,
      }),
    ).toEqual({
      ok: true,
      nextAssigneeId: USR_A,
      nextStatusId: STS_IN_PROGRESS,
      nextCompletedAt: null,
      reopened: false,
      changed: true,
    });
  });

  it("rejects tasks already assigned to another user even when reopen=true", () => {
    for (const reopen of [false, true]) {
      expect(
        planTaskStartTransition({
          actorUserId: USR_A,
          currentAssigneeId: USR_B,
          currentStatusId: STS_DONE,
          currentCompletedAt: "2026-11-28T00:00:00.000Z",
          projectStatuses: STATUSES,
          configuredStartStatusId: STS_IN_PROGRESS,
          reopen,
        }),
      ).toEqual({ ok: false, reason: "ALREADY_ASSIGNED" });
    }
  });

  it("returns changed=false for idempotent same-actor retry and never regresses advanced statuses", () => {
    expect(
      planTaskStartTransition({
        actorUserId: USR_A,
        currentAssigneeId: USR_A,
        currentStatusId: STS_IN_REVIEW,
        currentCompletedAt: null,
        projectStatuses: STATUSES,
        configuredStartStatusId: STS_IN_PROGRESS,
        reopen: false,
      }),
    ).toEqual({
      ok: true,
      nextAssigneeId: USR_A,
      nextStatusId: STS_IN_REVIEW,
      nextCompletedAt: null,
      reopened: false,
      changed: false,
    });

    expect(
      planTaskStartTransition({
        actorUserId: USR_A,
        currentAssigneeId: null,
        currentStatusId: STS_IN_REVIEW,
        currentCompletedAt: null,
        projectStatuses: STATUSES,
        configuredStartStatusId: STS_TODO,
        reopen: false,
      }),
    ).toEqual({
      ok: true,
      nextAssigneeId: USR_A,
      nextStatusId: STS_IN_REVIEW,
      nextCompletedAt: null,
      reopened: false,
      changed: true,
    });
  });

  it("requires explicit reopen for completed tasks and clears completedAt when reopened", () => {
    expect(
      planTaskStartTransition({
        actorUserId: USR_A,
        currentAssigneeId: USR_A,
        currentStatusId: STS_DONE,
        currentCompletedAt: "2026-11-28T00:00:00.000Z",
        projectStatuses: STATUSES,
        configuredStartStatusId: STS_IN_PROGRESS,
        reopen: false,
      }),
    ).toEqual({ ok: false, reason: "TASK_COMPLETED" });

    expect(
      planTaskStartTransition({
        actorUserId: USR_A,
        currentAssigneeId: null,
        currentStatusId: STS_IN_PROGRESS,
        currentCompletedAt: "2026-11-28T00:00:00.000Z",
        projectStatuses: STATUSES,
        configuredStartStatusId: STS_IN_PROGRESS,
        reopen: false,
      }),
    ).toEqual({ ok: false, reason: "TASK_COMPLETED" });

    expect(
      planTaskStartTransition({
        actorUserId: USR_A,
        currentAssigneeId: USR_A,
        currentStatusId: STS_DONE,
        currentCompletedAt: "2026-11-28T00:00:00.000Z",
        projectStatuses: STATUSES,
        configuredStartStatusId: STS_IN_PROGRESS,
        reopen: true,
      }),
    ).toEqual({
      ok: true,
      nextAssigneeId: USR_A,
      nextStatusId: STS_IN_PROGRESS,
      nextCompletedAt: null,
      reopened: true,
      changed: true,
    });
  });

  it("handles missing or done configuredStartStatusId safely without emitting invalid status IDs", () => {
    const missingId = "sts_01jf8x9z2k3m4n5p6q7r8s9t0z" as StatusId;
    expect(
      selectStartTargetStatus(STATUSES, missingId)?.id,
    ).toBe(STS_IN_PROGRESS);
    expect(
      selectStartTargetStatus(STATUSES, STS_DONE, { forReopen: true })?.id,
    ).toBe(STS_IN_PROGRESS);
    expect(
      selectStartTargetStatus([{ id: STS_TODO, category: "todo", position: 0 }], null, {
        forReopen: true,
      })?.id,
    ).toBe(STS_TODO);
    expect(
      selectStartTargetStatus([{ id: STS_DONE, category: "done", position: 0 }], STS_DONE, {
        forReopen: true,
      }),
    ).toBeNull();
  });
});
