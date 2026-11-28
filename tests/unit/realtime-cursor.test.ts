import { describe, expect, it } from "vitest";
import {
  advanceRealtimeCursor,
  buildInitialCursor,
  encodeRealtimeCursor,
  isCursorExpired,
  parseRealtimeCursor,
  stepRealtimeCursorForEvent,
  type RealtimeEventRecord,
  type RealtimeSnapshotState,
} from "@prood/application";
import { CONTRACT_VERSION, type RealtimeChangeEventDto, type TaskDto } from "@prood/contracts";
import { generateEntityId } from "@prood/domain";
import { applyRealtimeChangeToTasks } from "../../apps/web/src/realtime.js";

const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(1));
const wksB = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
const prjA = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(3));
const prjB = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(4));
const tsk1 = generateEntityId("tsk", 1_795_000_000_000, new Uint8Array(10).fill(5));
const tsk2 = generateEntityId("tsk", 1_795_000_000_000, new Uint8Array(10).fill(6));
const evt1 = generateEntityId("evt", 1_795_000_000_000, new Uint8Array(10).fill(7));

function makePgEvent(txid: string, seq: number): RealtimeEventRecord {
  return {
    seq,
    txid,
    workspaceId: wksA,
    projectId: prjA,
    eventId: evt1,
    eventType: "task.created",
    targetType: "task",
    targetId: tsk1,
    payload: {},
    occurredAt: "2026-11-28T12:00:00.000Z",
    createdAt: "2026-11-28T12:00:00.000Z",
  };
}

function makeTaskDto(id = tsk1, projectId = prjA, position = 0): TaskDto {
  return {
    id,
    workspaceId: wksA,
    projectId,
    effectiveProjectId: projectId,
    parentTaskId: null,
    statusId: null,
    issueKey: null,
    branchName: null,
    title: `Task ${id.slice(0, 8)}`,
    description: "",
    assigneeId: null,
    assigneeDisplayName: null,
    createdBy: null,
    dueOn: null,
    completedAt: null,
    position,
    createdAt: "2026-11-28T12:00:00.000Z",
    updatedAt: "2026-11-28T12:00:00.000Z",
  };
}

describe("realtime cursor codec and visibility watermarks", () => {
  it("round-trips sqlite and postgres cursors and rejects invalid/mismatched ones", () => {
    const sqCursor = buildInitialCursor(wksA, {
      driver: "sqlite",
      xmin: "0",
      xmax: "0",
      maxSeq: 42,
      visibleAtOrAboveXmin: [],
      retention: { prunedThroughTxid: "0", prunedThroughSeq: 0 },
    });
    const encodedSq = encodeRealtimeCursor(sqCursor);
    expect(encodedSq).toBe(`v1:sq:${wksA}:42`);
    expect(parseRealtimeCursor(encodedSq, "sqlite", wksA)).toEqual(sqCursor);
    expect(parseRealtimeCursor(encodedSq, "postgres", wksA)).toBeNull();
    expect(parseRealtimeCursor(encodedSq, "sqlite", wksB)).toBeNull();

    const pgCursor = buildInitialCursor(wksA, {
      driver: "postgres",
      xmin: "100",
      xmax: "105",
      maxSeq: 20,
      visibleAtOrAboveXmin: [{ txid: "102", seq: 19 }],
      retention: { prunedThroughTxid: "0", prunedThroughSeq: 0 },
    });
    const encodedPg = encodeRealtimeCursor(pgCursor);
    expect(encodedPg).toBe(`v1:pg:${wksA}:100:0:102.19`);
    expect(parseRealtimeCursor(encodedPg, "postgres", wksA)).toEqual(pgCursor);
    expect(parseRealtimeCursor("v1:pg:bad", "postgres", wksA)).toBeNull();
    expect(parseRealtimeCursor(`v1:pg:${wksA}:-1:0`, "postgres", wksA)).toBeNull();
  });

  it("handles out-of-order commits in postgres without skipping or duplicating", () => {
    // At T0: Tx 100 started (uncommitted), Tx 101 committed first with seq 2
    const snapT0: RealtimeSnapshotState = {
      driver: "postgres",
      xmin: "100",
      xmax: "102",
      maxSeq: 2,
      visibleAtOrAboveXmin: [],
      retention: { prunedThroughTxid: "0", prunedThroughSeq: 0 },
    };
    const c0 = buildInitialCursor(wksA, snapT0);
    expect(c0.safeTxid).toBe(100n);
    expect(c0.safeSeq).toBe(0);

    // Poll at T1: Tx 101 (seq 2) committed first; Tx 100 still active so xmin stays 100
    const snapT1: RealtimeSnapshotState = {
      driver: "postgres",
      xmin: "100",
      xmax: "102",
      maxSeq: 2,
      visibleAtOrAboveXmin: [{ txid: "101", seq: 2 }],
      retention: { prunedThroughTxid: "0", prunedThroughSeq: 0 },
    };
    const ev101 = makePgEvent("101", 2);
    const cAfterEv101 = stepRealtimeCursorForEvent(c0, ev101, snapT1);
    expect(cAfterEv101.safeTxid).toBe(100n);
    expect(cAfterEv101.seen).toEqual([{ txid: 101n, seq: 2 }]);

    const cAfterBatch1 = advanceRealtimeCursor(c0, [ev101], snapT1, 100);
    expect(cAfterBatch1.safeTxid).toBe(100n);
    expect(cAfterBatch1.seen).toEqual([{ txid: 101n, seq: 2 }]);

    // At T2: Tx 100 (seq 1) finally commits and xmin advances past 101 -> seen clears
    const snapT2: RealtimeSnapshotState = {
      driver: "postgres",
      xmin: "102",
      xmax: "102",
      maxSeq: 2,
      visibleAtOrAboveXmin: [],
      retention: { prunedThroughTxid: "0", prunedThroughSeq: 0 },
    };
    const ev100 = makePgEvent("100", 1);
    const cFinal = advanceRealtimeCursor(cAfterBatch1, [ev100], snapT2, 100);
    expect(cFinal.safeTxid).toBe(102n);
    expect(cFinal.safeSeq).toBe(0);
    expect(cFinal.seen).toEqual([]);
  });

  it("detects expired and future cursors accurately", () => {
    const sqSnap: RealtimeSnapshotState = {
      driver: "sqlite",
      xmin: "0",
      xmax: "0",
      maxSeq: 15,
      visibleAtOrAboveXmin: [],
      retention: { prunedThroughTxid: "0", prunedThroughSeq: 10 },
    };
    expect(
      isCursorExpired(parseRealtimeCursor(`v1:sq:${wksA}:9`, "sqlite", wksA)!, sqSnap),
    ).toBe(true);
    expect(
      isCursorExpired(parseRealtimeCursor(`v1:sq:${wksA}:10`, "sqlite", wksA)!, sqSnap),
    ).toBe(false);
    expect(
      isCursorExpired(parseRealtimeCursor(`v1:sq:${wksA}:16`, "sqlite", wksA)!, sqSnap),
    ).toBe(true);

    const pgSnap: RealtimeSnapshotState = {
      driver: "postgres",
      xmin: "200",
      xmax: "210",
      maxSeq: 50,
      visibleAtOrAboveXmin: [],
      retention: { prunedThroughTxid: "150", prunedThroughSeq: 30 },
    };
    expect(
      isCursorExpired(parseRealtimeCursor(`v1:pg:${wksA}:150:29`, "postgres", wksA)!, pgSnap),
    ).toBe(true);
    expect(
      isCursorExpired(parseRealtimeCursor(`v1:pg:${wksA}:150:30`, "postgres", wksA)!, pgSnap),
    ).toBe(false);
    expect(
      isCursorExpired(parseRealtimeCursor(`v1:pg:${wksA}:211:0`, "postgres", wksA)!, pgSnap),
    ).toBe(true);
  });

  it("applies realtime task mutations immutably onto active project list", () => {
    const initial = [makeTaskDto(tsk1, prjA, 1)];

    const started: RealtimeChangeEventDto = {
      contractVersion: CONTRACT_VERSION,
      type: "change",
      eventId: evt1,
      eventType: "task.started",
      workspaceId: wksA,
      projectId: prjA,
      taskId: tsk1,
      task: { ...makeTaskDto(tsk1, prjA, 1), title: "Started" },
      occurredAt: "2026-11-28T12:01:00.000Z",
      cursor: `v1:sq:${wksA}:2`,
    };
    const r1 = applyRealtimeChangeToTasks(initial, prjA, started);
    expect(r1.changed).toBe(true);
    expect(r1.highlightedTaskId).toBe(tsk1);
    expect(r1.tasks[0]?.title).toBe("Started");
    expect(initial[0]?.title).not.toBe("Started");

    const createdOtherProject: RealtimeChangeEventDto = {
      ...started,
      eventType: "task.created",
      projectId: prjB,
      taskId: tsk2,
      task: makeTaskDto(tsk2, prjB, 0),
    };
    expect(applyRealtimeChangeToTasks(r1.tasks, prjA, createdOtherProject).changed).toBe(false);

    const movedOut: RealtimeChangeEventDto = {
      ...started,
      eventType: "task.moved",
      projectId: prjB,
      fromProjectId: prjA,
      taskId: tsk1,
      task: makeTaskDto(tsk1, prjB, 1),
    };
    const r2 = applyRealtimeChangeToTasks(r1.tasks, prjA, movedOut);
    expect(r2.changed).toBe(true);
    expect(r2.tasks).toEqual([]);
  });
});
