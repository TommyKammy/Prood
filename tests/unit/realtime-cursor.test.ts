import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceRealtimeCursor,
  buildInitialCursor,
  encodeRealtimeCursor,
  isCursorExpired,
  MAX_PENDING_XIPS,
  parseRealtimeCursor,
  stepRealtimeCursorForEvent,
  type RealtimeEventRecord,
  type RealtimeSnapshotState,
} from "@prood/application";
import { CONTRACT_VERSION, type RealtimeChangeEventDto, type TaskDto } from "@prood/contracts";
import { generateEntityId } from "@prood/domain";
import {
  applyRealtimeChangeToTasks,
  createRealtimeController,
  replayRealtimeEventsOnSnapshot,
} from "../../apps/web/src/realtime.js";

const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(1));
const wksB = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
const prjA = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(3));
const prjB = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(4));
const tsk1 = generateEntityId("tsk", 1_795_000_000_000, new Uint8Array(10).fill(5));
const tsk2 = generateEntityId("tsk", 1_795_000_000_000, new Uint8Array(10).fill(6));
const tsk3 = generateEntityId("tsk", 1_795_000_000_000, new Uint8Array(10).fill(8));
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

function makeTaskDto(
  id = tsk1,
  projectId = prjA,
  position = 0,
  overrides: Partial<TaskDto> = {},
): TaskDto {
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
    ...overrides,
  };
}

describe("realtime cursor codec and visibility watermarks", () => {
  it("round-trips sqlite and postgres cursors and rejects invalid/mismatched ones", () => {
    const sqCursor = buildInitialCursor(wksA, {
      driver: "sqlite",
      xmin: "0",
      xmax: "0",
      maxSeq: 42,
      activeXips: [],
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
      activeXips: ["100", "103"],
      retention: { prunedThroughTxid: "0", prunedThroughSeq: 0 },
    });
    const encodedPg = encodeRealtimeCursor(pgCursor);
    expect(encodedPg).toBe(`v1:pg:${wksA}:105:0:100.0,103.0`);
    expect(parseRealtimeCursor(encodedPg, "postgres", wksA)).toEqual(pgCursor);
    expect(parseRealtimeCursor("v1:pg:bad", "postgres", wksA)).toBeNull();
    expect(parseRealtimeCursor(`v1:pg:${wksA}:-1:0`, "postgres", wksA)).toBeNull();
  });

  it("handles out-of-order commits and 700+ events while xmin is pinned without overflow", () => {
    // At T0: Tx 100 started (uncommitted); Tx 101 committed first at seq 1
    const snapT0: RealtimeSnapshotState = {
      driver: "postgres",
      xmin: "100",
      xmax: "100",
      maxSeq: 0,
      activeXips: [],
      retention: { prunedThroughTxid: "0", prunedThroughSeq: 0 },
    };
    const c0 = buildInitialCursor(wksA, snapT0);
    expect(c0.watermarkTxid).toBe(100n);
    expect(c0.pending).toEqual([]);

    // 7 batches of 100 committed events (txids 101..800) arrive while txid 100 stays active
    let cursor = c0;
    for (let batchIdx = 0; batchIdx < 7; batchIdx += 1) {
      const base = 101 + batchIdx * 100;
      const batch = Array.from({ length: 100 }, (_, i) =>
        makePgEvent(String(base + i), base + i),
      );
      const snapWhilePinned: RealtimeSnapshotState = {
        driver: "postgres",
        xmin: "100",
        xmax: String(base + 100),
        maxSeq: base + 99,
        activeXips: ["100"],
        retention: { prunedThroughTxid: "0", prunedThroughSeq: 0 },
      };
      const adv = advanceRealtimeCursor(cursor, batch, snapWhilePinned, 100);
      expect(adv.overflow).toBe(false);
      expect(adv.cursor.pending).toEqual([{ txid: 100n, afterSeq: 0 }]);
      expect(adv.cursor.watermarkTxid).toBe(BigInt(base + 99));
      cursor = adv.cursor;
    }

    // Finally Tx 100 commits at seq 1 -> picked up via pending and pending clears once drained
    const snapT2: RealtimeSnapshotState = {
      driver: "postgres",
      xmin: "801",
      xmax: "801",
      maxSeq: 800,
      activeXips: [],
      retention: { prunedThroughTxid: "0", prunedThroughSeq: 0 },
    };
    const ev100 = makePgEvent("100", 1);
    const mid = stepRealtimeCursorForEvent(cursor, ev100, snapT2);
    expect(mid.pending).toEqual([{ txid: 100n, afterSeq: 1 }]);

    const finalAdv = advanceRealtimeCursor(cursor, [ev100], snapT2, 100);
    expect(finalAdv.overflow).toBe(false);
    expect(finalAdv.cursor.watermarkTxid).toBe(801n);
    expect(finalAdv.cursor.watermarkSeq).toBe(0);
    expect(finalAdv.cursor.pending).toEqual([]);
  });

  it("reports explicit overflow rather than silently truncating pending xips", () => {
    const manyXips = Array.from({ length: MAX_PENDING_XIPS + 5 }, (_, i) =>
      String(200 + i),
    );
    const snapOverflow: RealtimeSnapshotState = {
      driver: "postgres",
      xmin: "200",
      xmax: String(200 + MAX_PENDING_XIPS + 10),
      maxSeq: 10,
      activeXips: manyXips,
      retention: { prunedThroughTxid: "0", prunedThroughSeq: 0 },
    };
    const startCursor = buildInitialCursor(wksA, {
      driver: "postgres",
      xmin: "199",
      xmax: "200",
      maxSeq: 1,
      activeXips: [],
      retention: { prunedThroughTxid: "0", prunedThroughSeq: 0 },
    });
    const res = advanceRealtimeCursor(startCursor, [], snapOverflow, 100);
    expect(res.overflow).toBe(true);
    expect(res.cursor.pending.length).toBeGreaterThan(MAX_PENDING_XIPS);
  });

  it("detects expired, pruned-pending, and future cursors accurately", () => {
    const sqSnap: RealtimeSnapshotState = {
      driver: "sqlite",
      xmin: "0",
      xmax: "0",
      maxSeq: 15,
      activeXips: [],
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
      activeXips: [],
      retention: { prunedThroughTxid: "150", prunedThroughSeq: 30 },
    };
    expect(
      isCursorExpired(parseRealtimeCursor(`v1:pg:${wksA}:150:29`, "postgres", wksA)!, pgSnap),
    ).toBe(true);
    expect(
      isCursorExpired(
        parseRealtimeCursor(`v1:pg:${wksA}:180:0:150.29`, "postgres", wksA)!,
        pgSnap,
      ),
    ).toBe(true);
    expect(
      isCursorExpired(parseRealtimeCursor(`v1:pg:${wksA}:150:30`, "postgres", wksA)!, pgSnap),
    ).toBe(false);
    expect(
      isCursorExpired(parseRealtimeCursor(`v1:pg:${wksA}:211:0`, "postgres", wksA)!, pgSnap),
    ).toBe(true);
  });

  it("cascades parent deletes, flags move reloads, and preserves newer SSE updates across snapshot replay", () => {
    const parent = makeTaskDto(tsk1, prjA, 0, { title: "Parent" });
    const child = makeTaskDto(tsk2, prjA, 1, {
      projectId: null,
      parentTaskId: tsk1,
      title: "Child Subtask",
    });
    const sibling = makeTaskDto(tsk3, prjA, 2, { title: "Unrelated" });

    // Deleting parent cascades to descendant subtask
    const deleteParentEv: RealtimeChangeEventDto = {
      contractVersion: CONTRACT_VERSION,
      type: "change",
      eventId: evt1,
      eventType: "task.deleted",
      workspaceId: wksA,
      projectId: prjA,
      taskId: tsk1,
      occurredAt: "2026-11-28T12:01:00.000Z",
      cursor: `v1:sq:${wksA}:2`,
    };
    const afterDel = applyRealtimeChangeToTasks([parent, child, sibling], prjA, deleteParentEv);
    expect(afterDel.changed).toBe(true);
    expect(afterDel.tasks.map((t) => t.id)).toEqual([tsk3]);

    // Moving parent flags needsReload so inherited/detached descendants synchronize
    const moveParentEv: RealtimeChangeEventDto = {
      ...deleteParentEv,
      eventType: "task.moved",
      projectId: prjB,
      fromProjectId: prjA,
      task: makeTaskDto(tsk1, prjB, 0),
    };
    const afterMove = applyRealtimeChangeToTasks([parent, child, sibling], prjA, moveParentEv);
    expect(afterMove.changed).toBe(true);
    expect(afterMove.needsReload).toBe(true);
    expect(afterMove.tasks.map((t) => t.id)).toEqual([tsk3]);

    // Snapshot replay: newer SSE task.started overrides stale REST snapshot,
    // while stale buffered event does NOT overwrite a newer REST snapshot.
    const staleSnap = [
      makeTaskDto(tsk1, prjA, 0, {
        title: "Alpha",
        assigneeId: null,
        updatedAt: "2026-11-28T12:00:00.000Z",
      }),
    ];
    const newerSseStarted: RealtimeChangeEventDto = {
      ...deleteParentEv,
      eventType: "task.started",
      task: makeTaskDto(tsk1, prjA, 0, {
        title: "Alpha",
        assigneeId: "usr_00000000000000000000000001" as never,
        assigneeDisplayName: "Alice",
        updatedAt: "2026-11-28T12:02:00.000Z",
      }),
    };
    const replayedNewer = replayRealtimeEventsOnSnapshot(staleSnap, prjA, [newerSseStarted]);
    expect(replayedNewer.tasks[0]?.assigneeDisplayName).toBe("Alice");

    const newerSnap = [
      makeTaskDto(tsk1, prjA, 0, {
        title: "Alpha Edited Later",
        assigneeId: "usr_00000000000000000000000002" as never,
        assigneeDisplayName: "Bob",
        updatedAt: "2026-11-28T12:05:00.000Z",
      }),
    ];
    const replayedOlder = replayRealtimeEventsOnSnapshot(newerSnap, prjA, [newerSseStarted]);
    expect(replayedOlder.tasks[0]?.title).toBe("Alpha Edited Later");
    expect(replayedOlder.tasks[0]?.assigneeDisplayName).toBe("Bob");
  });

  it("preserves explicitly owned detached children and their descendants on task.removed and task.moved", () => {
    const tsk4 = generateEntityId("tsk", 1_795_000_000_000, new Uint8Array(10).fill(9));
    const parent = makeTaskDto(tsk1, prjA, 0, { title: "Parent" });
    const inheritedChild = makeTaskDto(tsk2, prjA, 1, {
      projectId: null,
      parentTaskId: tsk1,
      title: "Inherited Child",
    });
    const ownedChild = makeTaskDto(tsk3, prjA, 2, {
      projectId: prjA,
      parentTaskId: tsk1,
      title: "Owned Child",
    });
    const ownedGrandchild = makeTaskDto(tsk4, prjA, 3, {
      projectId: null,
      parentTaskId: tsk3,
      title: "Owned Grandchild",
    });
    const tree = [parent, inheritedChild, ownedChild, ownedGrandchild];

    // Sanitized removal (parent moved to private project) preserves owned child + its subtree and requests reload
    const removedEv: RealtimeChangeEventDto = {
      contractVersion: CONTRACT_VERSION,
      type: "change",
      eventId: evt1,
      eventType: "task.removed",
      workspaceId: wksA,
      projectId: prjA,
      taskId: tsk1,
      occurredAt: "2026-11-28T12:01:00.000Z",
      cursor: `v1:sq:${wksA}:2`,
    };
    const afterRemoved = applyRealtimeChangeToTasks(tree, prjA, removedEv);
    expect(afterRemoved.changed).toBe(true);
    expect(afterRemoved.needsReload).toBe(true);
    expect(afterRemoved.tasks.map((t) => t.id)).toEqual([tsk3, tsk4]);
    expect(afterRemoved.tasks[0]?.parentTaskId).toBeNull();
    expect(afterRemoved.tasks[1]?.parentTaskId).toBe(tsk3);

    // Readable cross-project move preserves explicitly owned detached children immediately too
    const movedEv: RealtimeChangeEventDto = {
      ...removedEv,
      eventType: "task.moved",
      projectId: prjB,
      fromProjectId: prjA,
      task: makeTaskDto(tsk1, prjB, 0),
    };
    const afterMoved = applyRealtimeChangeToTasks(tree, prjA, movedEv);
    expect(afterMoved.changed).toBe(true);
    expect(afterMoved.needsReload).toBe(true);
    expect(afterMoved.tasks.map((t) => t.id)).toEqual([tsk3, tsk4]);
    expect(afterMoved.tasks[0]?.parentTaskId).toBeNull();
    expect(afterMoved.tasks[1]?.parentTaskId).toBe(tsk3);

    // Hard deletion still cascades across all descendants regardless of explicit ownership
    const deletedEv: RealtimeChangeEventDto = {
      ...removedEv,
      eventType: "task.deleted",
    };
    const afterDeleted = applyRealtimeChangeToTasks(tree, prjA, deletedEv);
    expect(afterDeleted.changed).toBe(true);
    expect(afterDeleted.needsReload).toBeUndefined();
    expect(afterDeleted.tasks).toEqual([]);
  });

  describe("createRealtimeController authorization recovery", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    function installMockEventSource() {
      const NativeEventTarget = globalThis.EventTarget;
      const NativeEvent = globalThis.Event;
      const opened: Array<{
        url: string;
        readyState: number;
        fail(): void;
        close(): void;
      }> = [];
      class MockEventSource extends NativeEventTarget {
        readyState = 1;
        constructor(public url: string) {
          super();
          opened.push(this);
        }
        fail() {
          this.readyState = 2;
          this.dispatchEvent(new NativeEvent("error"));
        }
        close() {
          this.readyState = 2;
        }
      }
      vi.stubGlobal("EventSource", MockEventSource);
      return opened;
    }

    it("invokes onRevoked and stops retrying on terminal error when session returns 401", async () => {
      vi.useFakeTimers();
      const opened = installMockEventSource();
      const onRevoked = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 401 })),
      );

      const ctrl = createRealtimeController({
        onChange: () => {},
        onResync: () => {},
        onRevoked,
      });
      ctrl.connect(wksA);
      expect(opened).toHaveLength(1);

      opened[0]!.fail();
      await vi.advanceTimersByTimeAsync(20_000);

      expect(onRevoked).toHaveBeenCalledTimes(1);
      expect(opened).toHaveLength(1);
      ctrl.close();
    });

    it("invokes onRevoked and stops retrying on terminal error when workspace membership is gone", async () => {
      vi.useFakeTimers();
      const opened = installMockEventSource();
      const onRevoked = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                contractVersion: CONTRACT_VERSION,
                memberships: [{ workspaceId: wksB }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        ),
      );

      const ctrl = createRealtimeController({
        onChange: () => {},
        onResync: () => {},
        onRevoked,
      });
      ctrl.connect(wksA);
      expect(opened).toHaveLength(1);

      opened[0]!.fail();
      await vi.advanceTimersByTimeAsync(20_000);

      expect(onRevoked).toHaveBeenCalledTimes(1);
      expect(opened).toHaveLength(1);
      ctrl.close();
    });

    it("keeps retrying with exponential backoff on transient failures when still authorized", async () => {
      vi.useFakeTimers();
      const opened = installMockEventSource();
      const onRevoked = vi.fn();
      const fetchMock = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockRejectedValueOnce(new Error("network down"));
      vi.stubGlobal("fetch", fetchMock);

      const ctrl = createRealtimeController({
        onChange: () => {},
        onResync: () => {},
        onRevoked,
      });
      ctrl.connect(wksA);
      expect(opened).toHaveLength(1);

      // 1st failure -> 503 -> retries after 1000ms
      opened[0]!.fail();
      await vi.advanceTimersByTimeAsync(999);
      expect(opened).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(opened).toHaveLength(2);
      expect(onRevoked).not.toHaveBeenCalled();

      // 2nd failure -> network error -> backs off to 2000ms
      opened[1]!.fail();
      await vi.advanceTimersByTimeAsync(1999);
      expect(opened).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(opened).toHaveLength(3);
      expect(onRevoked).not.toHaveBeenCalled();
      ctrl.close();
    });
  });
});
