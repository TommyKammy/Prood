import type { DbDriverKind } from "@prood/contracts";
import { isValidEntityId, type WorkspaceId } from "@prood/domain";
import type {
  RealtimeEventRecord,
  RealtimeSnapshotState,
} from "./persistence.js";

export interface PendingRealtimeTx {
  txid: bigint;
  afterSeq: number;
}

export interface ParsedRealtimeCursor {
  driver: DbDriverKind;
  workspaceId: WorkspaceId;
  watermarkTxid: bigint;
  watermarkSeq: number;
  pending: PendingRealtimeTx[];
}

export const MAX_PENDING_XIPS = 512;
const NON_NEG_INT_REGEX = /^(?:0|[1-9]\d*)$/;

function comparePos(aTxid: bigint, aSeq: number, bTxid: bigint, bSeq: number): number {
  if (aTxid !== bTxid) {
    return aTxid < bTxid ? -1 : 1;
  }
  return aSeq - bSeq;
}

function normalizePending(
  entries: readonly PendingRealtimeTx[],
  watermarkTxid: bigint,
): PendingRealtimeTx[] {
  const byTxid = new Map<bigint, number>();
  for (const entry of entries) {
    if (entry.txid >= watermarkTxid) {
      continue;
    }
    const prev = byTxid.get(entry.txid) ?? 0;
    if (entry.afterSeq > prev || !byTxid.has(entry.txid)) {
      byTxid.set(entry.txid, Math.max(0, entry.afterSeq));
    }
  }
  return Array.from(byTxid.entries())
    .map(([txid, afterSeq]) => ({ txid, afterSeq }))
    .sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0));
}

/**
 * Encodes a commit-visibility cursor for SSE `id:` and `Last-Event-ID` resume.
 */
export function encodeRealtimeCursor(cursor: ParsedRealtimeCursor): string {
  if (cursor.driver === "sqlite") {
    return `v1:sq:${cursor.workspaceId}:${cursor.watermarkSeq}`;
  }
  const base = `v1:pg:${cursor.workspaceId}:${cursor.watermarkTxid.toString()}:${cursor.watermarkSeq}`;
  if (cursor.pending.length === 0) {
    return base;
  }
  const encodedPending = cursor.pending
    .map((entry) => `${entry.txid.toString()}.${entry.afterSeq}`)
    .join(",");
  return `${base}:${encodedPending}`;
}

/**
 * Parses and validates an incoming SSE resume cursor against expected driver and workspace.
 */
export function parseRealtimeCursor(
  raw: string,
  expectedDriver: DbDriverKind,
  expectedWorkspaceId: WorkspaceId,
): ParsedRealtimeCursor | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 16_384) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts[0] !== "v1") {
    return null;
  }

  const tag = parts[1];
  const workspaceId = parts[2];
  if (
    !workspaceId ||
    !isValidEntityId("wks", workspaceId) ||
    workspaceId !== expectedWorkspaceId
  ) {
    return null;
  }

  if (tag === "sq") {
    if (expectedDriver !== "sqlite" || parts.length !== 4) {
      return null;
    }
    const seqStr = parts[3]!;
    if (!NON_NEG_INT_REGEX.test(seqStr)) {
      return null;
    }
    const watermarkSeq = Number(seqStr);
    if (!Number.isSafeInteger(watermarkSeq) || watermarkSeq < 0) {
      return null;
    }
    return {
      driver: "sqlite",
      workspaceId,
      watermarkTxid: 0n,
      watermarkSeq,
      pending: [],
    };
  }

  if (tag === "pg") {
    if (expectedDriver !== "postgres" || (parts.length !== 5 && parts.length !== 6)) {
      return null;
    }
    const txidStr = parts[3]!;
    const seqStr = parts[4]!;
    if (!NON_NEG_INT_REGEX.test(txidStr) || !NON_NEG_INT_REGEX.test(seqStr)) {
      return null;
    }
    const watermarkTxid = BigInt(txidStr);
    const watermarkSeq = Number(seqStr);
    if (!Number.isSafeInteger(watermarkSeq) || watermarkSeq < 0) {
      return null;
    }

    const pending: PendingRealtimeTx[] = [];
    if (parts.length === 6) {
      if (!parts[5]) {
        return null;
      }
      const tokens = parts[5].split(",");
      if (tokens.length > MAX_PENDING_XIPS) {
        return null;
      }
      for (const token of tokens) {
        const dotIdx = token.indexOf(".");
        if (dotIdx <= 0) {
          return null;
        }
        const entryTx = token.slice(0, dotIdx);
        const afterSeqStr = token.slice(dotIdx + 1);
        if (!NON_NEG_INT_REGEX.test(entryTx) || !NON_NEG_INT_REGEX.test(afterSeqStr)) {
          return null;
        }
        const afterSeq = Number(afterSeqStr);
        if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
          return null;
        }
        pending.push({ txid: BigInt(entryTx), afterSeq });
      }
    }

    const normalized = normalizePending(pending, watermarkTxid);
    if (normalized.length > MAX_PENDING_XIPS) {
      return null;
    }
    return {
      driver: "postgres",
      workspaceId,
      watermarkTxid,
      watermarkSeq,
      pending: normalized,
    };
  }

  return null;
}

/**
 * Builds an initial snapshot-safe cursor at subscription open or full resync.
 * On PostgreSQL, `watermarkTxid` starts at `xmax` and only in-progress active
 * transaction IDs (`pg_snapshot_xip`) are retained in `pending`. If active
 * transactions exceed `MAX_PENDING_XIPS`, falls back safely to `(xmin, 0, [])`.
 */
export function buildInitialCursor(
  workspaceId: WorkspaceId,
  snapshot: RealtimeSnapshotState,
): ParsedRealtimeCursor {
  if (snapshot.driver === "sqlite") {
    return {
      driver: "sqlite",
      workspaceId,
      watermarkTxid: 0n,
      watermarkSeq: snapshot.maxSeq,
      pending: [],
    };
  }
  const xmax = BigInt(snapshot.xmax);
  const rawPending = normalizePending(
    snapshot.activeXips.map((txid) => ({ txid: BigInt(txid), afterSeq: 0 })),
    xmax,
  );
  if (rawPending.length > MAX_PENDING_XIPS) {
    return {
      driver: "postgres",
      workspaceId,
      watermarkTxid: BigInt(snapshot.xmin),
      watermarkSeq: 0,
      pending: [],
    };
  }
  return {
    driver: "postgres",
    workspaceId,
    watermarkTxid: xmax,
    watermarkSeq: 0,
    pending: rawPending,
  };
}

/**
 * Returns true if the cursor points before pruned retention history, ahead of
 * the current snapshot horizon, or exceeds pending xip capacity.
 */
export function isCursorExpired(
  cursor: ParsedRealtimeCursor,
  snapshot: RealtimeSnapshotState,
): boolean {
  if (cursor.driver === "sqlite") {
    const horizonSeq = Math.max(snapshot.maxSeq, snapshot.retention.prunedThroughSeq);
    if (cursor.watermarkSeq > horizonSeq) {
      return true;
    }
    if (
      snapshot.retention.prunedThroughSeq > 0 &&
      cursor.watermarkSeq < snapshot.retention.prunedThroughSeq
    ) {
      return true;
    }
    return false;
  }

  if (cursor.pending.length > MAX_PENDING_XIPS) {
    return true;
  }

  const xmax = BigInt(snapshot.xmax);
  if (cursor.watermarkTxid > xmax) {
    return true;
  }
  for (const entry of cursor.pending) {
    if (entry.txid > xmax) {
      return true;
    }
  }

  const prunedTxid = BigInt(snapshot.retention.prunedThroughTxid);
  const prunedSeq = snapshot.retention.prunedThroughSeq;
  if (prunedTxid > 0n) {
    let earliestTxid = cursor.watermarkTxid;
    let earliestSeq = cursor.watermarkSeq;
    for (const entry of cursor.pending) {
      if (comparePos(entry.txid, entry.afterSeq, earliestTxid, earliestSeq) < 0) {
        earliestTxid = entry.txid;
        earliestSeq = entry.afterSeq;
      }
    }
    if (comparePos(earliestTxid, earliestSeq, prunedTxid, prunedSeq) < 0) {
      return true;
    }
  }

  return false;
}

/**
 * Advances a cursor for a single emitted event so a mid-batch disconnect can
 * resume from `Last-Event-ID` without missing out-of-order commits.
 */
export function stepRealtimeCursorForEvent(
  cursor: ParsedRealtimeCursor,
  event: Pick<RealtimeEventRecord, "txid" | "seq">,
  snapshot: RealtimeSnapshotState,
): ParsedRealtimeCursor {
  if (cursor.driver === "sqlite") {
    return {
      ...cursor,
      watermarkSeq: Math.max(cursor.watermarkSeq, event.seq),
      pending: [],
    };
  }

  const evTxid = BigInt(event.txid);
  const activeSet = new Set(snapshot.activeXips.map((x) => BigInt(x)));

  if (evTxid < cursor.watermarkTxid) {
    // Drop non-active pending entries earlier than `evTxid` because their
    // committed rows would already have been ordered ahead of `evTxid`.
    const retained = cursor.pending.filter(
      (entry) =>
        entry.txid === evTxid ||
        entry.txid > evTxid ||
        activeSet.has(entry.txid),
    );
    const nextPending = retained.some((e) => e.txid === evTxid)
      ? retained.map((e) =>
          e.txid === evTxid
            ? { txid: evTxid, afterSeq: Math.max(e.afterSeq, event.seq) }
            : e,
        )
      : [...retained, { txid: evTxid, afterSeq: event.seq }];
    return {
      driver: "postgres",
      workspaceId: cursor.workspaceId,
      watermarkTxid: cursor.watermarkTxid,
      watermarkSeq: cursor.watermarkSeq,
      pending: normalizePending(nextPending, cursor.watermarkTxid),
    };
  }

  if (evTxid === cursor.watermarkTxid) {
    const nextWatermarkSeq = Math.max(cursor.watermarkSeq, event.seq);
    const retained = cursor.pending.filter((entry) => activeSet.has(entry.txid));
    return {
      driver: "postgres",
      workspaceId: cursor.workspaceId,
      watermarkTxid: cursor.watermarkTxid,
      watermarkSeq: nextWatermarkSeq,
      pending: normalizePending(retained, cursor.watermarkTxid),
    };
  }

  // `evTxid > cursor.watermarkTxid`: any transaction `< evTxid` not in `activeSet`
  // has either already had all committed rows read before this event or rolled back.
  const crossedActive: PendingRealtimeTx[] = [];
  for (const xip of activeSet) {
    if (xip >= cursor.watermarkTxid && xip < evTxid) {
      crossedActive.push({ txid: xip, afterSeq: 0 });
    }
  }
  const prevActive = cursor.pending.filter((entry) => activeSet.has(entry.txid));
  return {
    driver: "postgres",
    workspaceId: cursor.workspaceId,
    watermarkTxid: evTxid,
    watermarkSeq: event.seq,
    pending: normalizePending([...prevActive, ...crossedActive], evTxid),
  };
}

/**
 * Advances the subscription's polling cursor after processing a batch, promoting
 * the watermark to `xmax` when all visible rows below `xmax` have been drained.
 * Reports `overflow: true` if concurrent uncommitted transactions exceed
 * `MAX_PENDING_XIPS` so callers can trigger an explicit resync instead of truncating.
 */
export function advanceRealtimeCursor(
  cursor: ParsedRealtimeCursor,
  batch: readonly RealtimeEventRecord[],
  snapshot: RealtimeSnapshotState,
  limit: number,
): { cursor: ParsedRealtimeCursor; overflow: boolean } {
  let current = cursor;
  for (const ev of batch) {
    current = stepRealtimeCursorForEvent(current, ev, snapshot);
  }

  if (current.driver === "sqlite") {
    return { cursor: current, overflow: false };
  }

  if (batch.length < limit) {
    const xmax = BigInt(snapshot.xmax);
    const nextWatermarkTxid = xmax > current.watermarkTxid ? xmax : current.watermarkTxid;
    const nextWatermarkSeq =
      nextWatermarkTxid === current.watermarkTxid ? current.watermarkSeq : 0;

    const existingByTx = new Map(current.pending.map((p) => [p.txid, p.afterSeq]));
    const nextPending: PendingRealtimeTx[] = [];
    for (const rawXip of snapshot.activeXips) {
      const xip = BigInt(rawXip);
      if (xip < nextWatermarkTxid) {
        const preservedAfter =
          xip < current.watermarkTxid ? (existingByTx.get(xip) ?? 0) : 0;
        nextPending.push({ txid: xip, afterSeq: preservedAfter });
      }
    }
    const normalized = normalizePending(nextPending, nextWatermarkTxid);
    return {
      cursor: {
        driver: "postgres",
        workspaceId: current.workspaceId,
        watermarkTxid: nextWatermarkTxid,
        watermarkSeq: nextWatermarkSeq,
        pending: normalized,
      },
      overflow: normalized.length > MAX_PENDING_XIPS,
    };
  }

  return {
    cursor: current,
    overflow: current.pending.length > MAX_PENDING_XIPS,
  };
}
