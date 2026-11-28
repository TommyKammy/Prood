import type { DbDriverKind } from "@prood/contracts";
import { isValidEntityId, type WorkspaceId } from "@prood/domain";
import type {
  RealtimeEventRecord,
  RealtimeSnapshotState,
} from "./persistence.js";

export interface SeenRealtimeEntry {
  txid: bigint;
  seq: number;
}

export interface ParsedRealtimeCursor {
  driver: DbDriverKind;
  workspaceId: WorkspaceId;
  safeTxid: bigint;
  safeSeq: number;
  seen: SeenRealtimeEntry[];
}

const MAX_SEEN_ENTRIES = 512;
const NON_NEG_INT_REGEX = /^(?:0|[1-9]\d*)$/;

function comparePos(aTxid: bigint, aSeq: number, bTxid: bigint, bSeq: number): number {
  if (aTxid !== bTxid) {
    return aTxid < bTxid ? -1 : 1;
  }
  return aSeq - bSeq;
}

function normalizeSeen(
  entries: readonly SeenRealtimeEntry[],
  safeTxid: bigint,
  safeSeq: number,
): SeenRealtimeEntry[] {
  const bySeq = new Map<number, SeenRealtimeEntry>();
  for (const entry of entries) {
    if (comparePos(entry.txid, entry.seq, safeTxid, safeSeq) <= 0) {
      continue;
    }
    bySeq.set(entry.seq, entry);
  }
  return Array.from(bySeq.values())
    .sort((a, b) => comparePos(a.txid, a.seq, b.txid, b.seq))
    .slice(0, MAX_SEEN_ENTRIES);
}

/**
 * Encodes a commit-visibility cursor for SSE `id:` and `Last-Event-ID` resume.
 */
export function encodeRealtimeCursor(cursor: ParsedRealtimeCursor): string {
  if (cursor.driver === "sqlite") {
    return `v1:sq:${cursor.workspaceId}:${cursor.safeSeq}`;
  }
  const base = `v1:pg:${cursor.workspaceId}:${cursor.safeTxid.toString()}:${cursor.safeSeq}`;
  if (cursor.seen.length === 0) {
    return base;
  }
  const encodedSeen = cursor.seen
    .map((entry) => `${entry.txid.toString()}.${entry.seq}`)
    .join(",");
  return `${base}:${encodedSeen}`;
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
  if (!workspaceId || !isValidEntityId("wks", workspaceId) || workspaceId !== expectedWorkspaceId) {
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
    const safeSeq = Number(seqStr);
    if (!Number.isSafeInteger(safeSeq) || safeSeq < 0) {
      return null;
    }
    return {
      driver: "sqlite",
      workspaceId,
      safeTxid: 0n,
      safeSeq,
      seen: [],
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
    const safeTxid = BigInt(txidStr);
    const safeSeq = Number(seqStr);
    if (!Number.isSafeInteger(safeSeq) || safeSeq < 0) {
      return null;
    }

    const seen: SeenRealtimeEntry[] = [];
    if (parts.length === 6) {
      if (!parts[5]) {
        return null;
      }
      const tokens = parts[5].split(",");
      if (tokens.length > MAX_SEEN_ENTRIES) {
        return null;
      }
      for (const token of tokens) {
        const dotIdx = token.indexOf(".");
        if (dotIdx <= 0) {
          return null;
        }
        const entryTx = token.slice(0, dotIdx);
        const entrySeqStr = token.slice(dotIdx + 1);
        if (!NON_NEG_INT_REGEX.test(entryTx) || !NON_NEG_INT_REGEX.test(entrySeqStr)) {
          return null;
        }
        const entrySeq = Number(entrySeqStr);
        if (!Number.isSafeInteger(entrySeq) || entrySeq <= 0) {
          return null;
        }
        seen.push({ txid: BigInt(entryTx), seq: entrySeq });
      }
    }

    return {
      driver: "postgres",
      workspaceId,
      safeTxid,
      safeSeq,
      seen: normalizeSeen(seen, safeTxid, safeSeq),
    };
  }

  return null;
}

/**
 * Builds an initial snapshot-safe cursor at subscription open or full resync.
 * On PostgreSQL, transactions with `txid >= xmin` that already committed are recorded
 * in `seen` so concurrent uncommitted transactions with smaller txids are still
 * delivered once they commit.
 */
export function buildInitialCursor(
  workspaceId: WorkspaceId,
  snapshot: RealtimeSnapshotState,
): ParsedRealtimeCursor {
  if (snapshot.driver === "sqlite") {
    return {
      driver: "sqlite",
      workspaceId,
      safeTxid: 0n,
      safeSeq: snapshot.maxSeq,
      seen: [],
    };
  }
  const safeTxid = BigInt(snapshot.xmin);
  const seen = normalizeSeen(
    snapshot.visibleAtOrAboveXmin.map((entry) => ({
      txid: BigInt(entry.txid),
      seq: entry.seq,
    })),
    safeTxid,
    0,
  );
  return {
    driver: "postgres",
    workspaceId,
    safeTxid,
    safeSeq: 0,
    seen,
  };
}

/**
 * Returns true if the cursor points before pruned retention history or ahead of
 * the current snapshot horizon.
 */
export function isCursorExpired(
  cursor: ParsedRealtimeCursor,
  snapshot: RealtimeSnapshotState,
): boolean {
  if (cursor.driver === "sqlite") {
    const horizonSeq = Math.max(snapshot.maxSeq, snapshot.retention.prunedThroughSeq);
    if (cursor.safeSeq > horizonSeq) {
      return true;
    }
    if (
      snapshot.retention.prunedThroughSeq > 0 &&
      cursor.safeSeq < snapshot.retention.prunedThroughSeq
    ) {
      return true;
    }
    return false;
  }

  const xmax = BigInt(snapshot.xmax);
  if (cursor.safeTxid > xmax) {
    return true;
  }
  for (const entry of cursor.seen) {
    if (entry.txid > xmax) {
      return true;
    }
  }
  const prunedTxid = BigInt(snapshot.retention.prunedThroughTxid);
  const prunedSeq = snapshot.retention.prunedThroughSeq;
  if (
    prunedTxid > 0n &&
    comparePos(cursor.safeTxid, cursor.safeSeq, prunedTxid, prunedSeq) < 0
  ) {
    return true;
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
      safeSeq: Math.max(cursor.safeSeq, event.seq),
      seen: [],
    };
  }

  const xmin = BigInt(snapshot.xmin);
  const evTxid = BigInt(event.txid);
  if (
    evTxid < xmin &&
    comparePos(evTxid, event.seq, cursor.safeTxid, cursor.safeSeq) > 0
  ) {
    return {
      driver: "postgres",
      workspaceId: cursor.workspaceId,
      safeTxid: evTxid,
      safeSeq: event.seq,
      seen: normalizeSeen(cursor.seen, evTxid, event.seq),
    };
  }

  return {
    driver: "postgres",
    workspaceId: cursor.workspaceId,
    safeTxid: cursor.safeTxid,
    safeSeq: cursor.safeSeq,
    seen: normalizeSeen(
      [...cursor.seen, { txid: evTxid, seq: event.seq }],
      cursor.safeTxid,
      cursor.safeSeq,
    ),
  };
}

/**
 * Advances the subscription's polling cursor after processing a batch, promoting
 * the watermark to `xmin` when all visible rows below `xmin` have been drained.
 */
export function advanceRealtimeCursor(
  cursor: ParsedRealtimeCursor,
  batch: readonly RealtimeEventRecord[],
  snapshot: RealtimeSnapshotState,
  limit: number,
): ParsedRealtimeCursor {
  if (cursor.driver === "sqlite") {
    if (batch.length === 0) {
      return cursor;
    }
    return {
      driver: "sqlite",
      workspaceId: cursor.workspaceId,
      safeTxid: 0n,
      safeSeq: Math.max(cursor.safeSeq, batch[batch.length - 1]!.seq),
      seen: [],
    };
  }

  const xmin = BigInt(snapshot.xmin);
  if (batch.length >= limit) {
    const last = batch[batch.length - 1]!;
    const lastTxid = BigInt(last.txid);
    if (
      lastTxid < xmin &&
      comparePos(lastTxid, last.seq, cursor.safeTxid, cursor.safeSeq) > 0
    ) {
      return {
        driver: "postgres",
        workspaceId: cursor.workspaceId,
        safeTxid: lastTxid,
        safeSeq: last.seq,
        seen: normalizeSeen(cursor.seen, lastTxid, last.seq),
      };
    }
  }

  let nextSafeTxid = cursor.safeTxid;
  let nextSafeSeq = cursor.safeSeq;
  if (xmin > cursor.safeTxid) {
    nextSafeTxid = xmin;
    nextSafeSeq = 0;
  }

  const combinedSeen = [
    ...cursor.seen,
    ...batch.map((ev) => ({ txid: BigInt(ev.txid), seq: ev.seq })),
  ];
  return {
    driver: "postgres",
    workspaceId: cursor.workspaceId,
    safeTxid: nextSafeTxid,
    safeSeq: nextSafeSeq,
    seen: normalizeSeen(combinedSeen, nextSafeTxid, nextSafeSeq),
  };
}
