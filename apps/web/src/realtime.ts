import type { ProjectId, TaskPublicId, WorkspaceId } from "@prood/domain";
import type {
  RealtimeChangeEventDto,
  RealtimeReadyEventDto,
  RealtimeResyncEventDto,
  TaskDto,
} from "@prood/contracts";

export interface RealtimeApplyResult {
  tasks: TaskDto[];
  changed: boolean;
  needsReload?: boolean;
  highlightedTaskId?: TaskPublicId | null;
}

function compareTasks(a: TaskDto, b: TaskDto): number {
  return (
    a.position - b.position ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function removeTaskSubtree(tasks: readonly TaskDto[], rootId: TaskPublicId): TaskDto[] {
  const removedIds = new Set<TaskPublicId>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const item of tasks) {
      if (
        item.parentTaskId &&
        removedIds.has(item.parentTaskId) &&
        !removedIds.has(item.id)
      ) {
        removedIds.add(item.id);
        added = true;
      }
    }
  }
  return tasks.filter((item) => !removedIds.has(item.id));
}

function removeMovedSubtree(
  tasks: readonly TaskDto[],
  rootId: TaskPublicId,
): { tasks: TaskDto[]; changed: boolean } {
  const removedIds = new Set<TaskPublicId>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const item of tasks) {
      if (
        item.projectId === null &&
        item.parentTaskId &&
        removedIds.has(item.parentTaskId) &&
        !removedIds.has(item.id)
      ) {
        removedIds.add(item.id);
        added = true;
      }
    }
  }
  let changed = false;
  const next: TaskDto[] = [];
  for (const item of tasks) {
    if (removedIds.has(item.id)) {
      changed = true;
      continue;
    }
    // Mirrors `partitionMovingSubtreeInTx()`: explicitly owned children stay in their
    // source project with `parentTaskId` detached when a parent moves to another project.
    if (item.parentTaskId && removedIds.has(item.parentTaskId)) {
      changed = true;
      next.push({ ...item, parentTaskId: null });
      continue;
    }
    next.push(item);
  }
  return { tasks: next, changed };
}

/**
 * Applies an incoming SSE task change event onto the currently rendered project's
 * task array without mutating the source array. Cascades parent deletions to any
 * rendered descendants, preserves explicitly owned detached children across moves,
 * and flags `needsReload` on parent moves/removals affecting the view.
 */
export function applyRealtimeChangeToTasks(
  tasks: readonly TaskDto[],
  activeProjectId: ProjectId | null,
  event: RealtimeChangeEventDto,
): RealtimeApplyResult {
  if (!activeProjectId) {
    return { tasks: [...tasks], changed: false };
  }

  const targetId = event.taskId ?? event.task?.id;
  if (event.eventType === "task.deleted") {
    if (!targetId) {
      return { tasks: [...tasks], changed: false };
    }
    const next = removeTaskSubtree(tasks, targetId);
    return {
      tasks: next,
      changed: next.length !== tasks.length,
    };
  }

  if (event.eventType === "task.removed") {
    if (!targetId) {
      return { tasks: [...tasks], changed: false };
    }
    const removed = removeMovedSubtree(tasks, targetId);
    const shouldReload =
      removed.changed ||
      event.projectId === activeProjectId ||
      tasks.some((item) => item.parentTaskId === targetId);
    return {
      tasks: removed.tasks,
      changed: removed.changed,
      ...(shouldReload ? { needsReload: true } : {}),
    };
  }

  if (
    event.eventType === "task.created" ||
    event.eventType === "task.updated" ||
    event.eventType === "task.started" ||
    event.eventType === "task.moved"
  ) {
    const incoming = event.task;
    const isMove = event.eventType === "task.moved";
    if (!incoming) {
      return { tasks: [...tasks], changed: false };
    }
    const existingIndex = tasks.findIndex((item) => item.id === incoming.id);
    const affectsSubtree =
      isMove &&
      (incoming.effectiveProjectId === activeProjectId ||
        event.projectId === activeProjectId ||
        event.fromProjectId === activeProjectId ||
        existingIndex >= 0 ||
        tasks.some((item) => item.parentTaskId === incoming.id));

    if (incoming.effectiveProjectId !== activeProjectId) {
      if (existingIndex === -1) {
        return {
          tasks: [...tasks],
          changed: false,
          ...(affectsSubtree ? { needsReload: true } : {}),
        };
      }
      return {
        tasks: isMove
          ? removeMovedSubtree(tasks, incoming.id).tasks
          : tasks.filter((_, idx) => idx !== existingIndex),
        changed: true,
        ...(affectsSubtree ? { needsReload: true } : {}),
      };
    }

    const updated =
      existingIndex >= 0
        ? tasks.map((item, idx) => (idx === existingIndex ? incoming : item))
        : [...tasks, incoming].sort(compareTasks);
    return {
      tasks: updated,
      changed: true,
      highlightedTaskId: incoming.id,
      ...(affectsSubtree ? { needsReload: true } : {}),
    };
  }

  return { tasks: [...tasks], changed: false };
}

/**
 * Replays buffered SSE events onto a freshly loaded REST task-list snapshot so
 * concurrent SSE mutations that arrived while `listProjectTasks` was in flight
 * are preserved instead of overwritten by stale snapshot rows.
 */
export function replayRealtimeEventsOnSnapshot(
  snapshotTasks: readonly TaskDto[],
  activeProjectId: ProjectId | null,
  buffered: readonly RealtimeChangeEventDto[],
): { tasks: TaskDto[]; needsReload: boolean; highlightedTaskId?: TaskPublicId | null } {
  let current = [...snapshotTasks];
  let needsReload = false;
  let highlightedTaskId: TaskPublicId | null | undefined;

  for (const event of buffered) {
    if (event.task) {
      const existing = current.find((item) => item.id === event.task!.id);
      if (existing && existing.updatedAt > event.task.updatedAt) {
        if (
          event.eventType === "task.moved" &&
          (event.projectId === activeProjectId || event.fromProjectId === activeProjectId)
        ) {
          needsReload = true;
        }
        continue;
      }
    }
    const applied = applyRealtimeChangeToTasks(current, activeProjectId, event);
    current = applied.tasks;
    if (applied.needsReload) {
      needsReload = true;
    }
    if (applied.highlightedTaskId !== undefined) {
      highlightedTaskId = applied.highlightedTaskId;
    }
  }

  return {
    tasks: current,
    needsReload,
    ...(highlightedTaskId !== undefined ? { highlightedTaskId } : {}),
  };
}

export interface RealtimeControllerOptions {
  onReady?: (event: RealtimeReadyEventDto, initial: boolean) => void;
  onChange: (event: RealtimeChangeEventDto) => void;
  onResync: (event: RealtimeResyncEventDto) => void;
  onRevoked: () => void;
}

export interface SavedFocusState {
  selector: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: "forward" | "backward" | "none" | null;
}

function escapeAttrValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * Captures the currently focused descendant control inside `root` together with its
 * text selection range so full DOM re-renders triggered by SSE do not interrupt typing.
 */
export function captureFocusState(root: HTMLElement): SavedFocusState | null {
  if (typeof document === "undefined") {
    return null;
  }
  const active = document.activeElement;
  if (!active || !(active instanceof Element) || !root.contains(active)) {
    return null;
  }
  let selector = "";
  if (active.id) {
    selector = `[id="${escapeAttrValue(active.id)}"]`;
  } else {
    const dataParts: string[] = [];
    for (const attr of Array.from(active.attributes)) {
      if (attr.name.indexOf("data-") === 0) {
        dataParts.push(
          attr.value
            ? `[${attr.name}="${escapeAttrValue(attr.value)}"]`
            : `[${attr.name}]`,
        );
      }
    }
    if (dataParts.length > 0) {
      selector = dataParts.join("");
    }
  }
  if (!selector) {
    return null;
  }

  let selectionStart: number | null = null;
  let selectionEnd: number | null = null;
  let selectionDirection: "forward" | "backward" | "none" | null = null;
  const tag = active.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA") {
    try {
      const inputEl = active as HTMLInputElement | HTMLTextAreaElement;
      selectionStart = inputEl.selectionStart;
      selectionEnd = inputEl.selectionEnd;
      selectionDirection =
        inputEl.selectionDirection === "forward" ||
        inputEl.selectionDirection === "backward" ||
        inputEl.selectionDirection === "none"
          ? inputEl.selectionDirection
          : null;
    } catch {
      // Non-text inputs such as checkboxes do not expose selection offsets
    }
  }

  return { selector, selectionStart, selectionEnd, selectionDirection };
}

/**
 * Restores focus and text selection onto the matching recreated descendant inside `root`.
 */
export function restoreFocusState(
  root: HTMLElement,
  state: SavedFocusState | null,
): void {
  if (!state) {
    return;
  }
  const target = root.querySelector<HTMLElement>(state.selector);
  if (!target || typeof target.focus !== "function") {
    return;
  }
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
  if (state.selectionStart !== null && state.selectionEnd !== null) {
    const maybeInput = target as HTMLInputElement;
    if (typeof maybeInput.setSelectionRange === "function") {
      try {
        maybeInput.setSelectionRange(
          state.selectionStart,
          state.selectionEnd,
          state.selectionDirection ?? undefined,
        );
      } catch {
        // Ignore controls whose type does not support selection ranges
      }
    }
  }
}

export interface ShellRealtimeBridgeHost {
  getActiveWorkspaceId(): WorkspaceId | null;
  getActiveProjectId(): ProjectId | null;
  getTasks(): readonly TaskDto[];
  setTasks(tasks: TaskDto[], highlightedTaskId?: TaskPublicId | null, liveNotice?: string): void;
  pushPendingEvent(event: RealtimeChangeEventDto): void;
  reloadWorkspace(workspaceId: WorkspaceId): void;
  reloadProject(projectId: ProjectId): void;
  refreshSession(): void;
  formatTaskNotice(title: string): string;
}

/**
 * Creates a controller wired directly to shell state transitions so eager `shell.ts`
 * stays lightweight while still handling initial ready reconciliation, event patching,
 * resyncs, and session revocation.
 */
export function createShellRealtimeController(
  host: ShellRealtimeBridgeHost,
): RealtimeController {
  return createRealtimeController({
    onReady: (ev, initial) => {
      if (initial && host.getActiveWorkspaceId() === ev.workspaceId) {
        host.reloadWorkspace(ev.workspaceId);
      }
    },
    onChange: (ev) => {
      host.pushPendingEvent(ev);
      const activeProjectId = host.getActiveProjectId();
      const applied = applyRealtimeChangeToTasks(host.getTasks(), activeProjectId, ev);
      if (applied.changed) {
        host.setTasks(
          applied.tasks,
          applied.highlightedTaskId,
          ev.task ? host.formatTaskNotice(ev.task.title) : undefined,
        );
      } else if (ev.eventType.indexOf("task.") !== 0) {
        const wsId = host.getActiveWorkspaceId();
        if (wsId) {
          host.reloadWorkspace(wsId);
        }
      }
      if (applied.needsReload && activeProjectId) {
        host.reloadProject(activeProjectId);
      }
    },
    onResync: () => {
      const wsId = host.getActiveWorkspaceId();
      if (wsId) {
        host.reloadWorkspace(wsId);
      }
    },
    onRevoked: () => {
      host.refreshSession();
    },
  });
}

export interface RealtimeController {
  connect(workspaceId: WorkspaceId): void;
  close(): void;
  getLastCursor(): string | null;
}

/**
 * Manages the authenticated workspace SSE subscription with cursor tracking
 * and bounded exponential-backoff reconnection.
 */
export function createRealtimeController(
  options: RealtimeControllerOptions,
): RealtimeController {
  let activeWorkspaceId: WorkspaceId | null = null;
  let source: EventSource | null = null;
  let lastCursor: string | null = null;
  let awaitingInitialReady = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = 1000;
  let closedManually = false;

  const clearTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const closeSource = () => {
    if (source) {
      source.close();
      source = null;
    }
  };

  const openStream = (workspaceId: WorkspaceId) => {
    if (closedManually || typeof EventSource !== "function") {
      return;
    }
    closeSource();
    const url = lastCursor
      ? `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/events?cursor=${encodeURIComponent(lastCursor)}`
      : `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/events`;
    const es = new EventSource(url, { withCredentials: true });
    source = es;

    es.addEventListener("ready", (rawEvent) => {
      if (source !== es) return;
      reconnectDelayMs = 1000;
      const initial = awaitingInitialReady;
      awaitingInitialReady = false;
      const msg = rawEvent as MessageEvent<string>;
      try {
        const payload = JSON.parse(msg.data) as RealtimeReadyEventDto;
        const cursor = msg.lastEventId || payload.cursor;
        if (cursor) {
          lastCursor = cursor;
        }
        options.onReady?.(payload, initial);
      } catch {
        // Ignore malformed frame data
      }
    });

    es.addEventListener("change", (rawEvent) => {
      if (source !== es) return;
      reconnectDelayMs = 1000;
      const msg = rawEvent as MessageEvent<string>;
      try {
        const payload = JSON.parse(msg.data) as RealtimeChangeEventDto;
        const cursor = msg.lastEventId || payload.cursor;
        if (cursor) {
          lastCursor = cursor;
        }
        options.onChange(payload);
      } catch {
        // Ignore malformed frame data
      }
    });

    es.addEventListener("resync", (rawEvent) => {
      if (source !== es) return;
      reconnectDelayMs = 1000;
      awaitingInitialReady = false;
      const msg = rawEvent as MessageEvent<string>;
      try {
        const payload = JSON.parse(msg.data) as RealtimeResyncEventDto;
        const cursor = msg.lastEventId || payload.cursor;
        if (cursor) {
          lastCursor = cursor;
        }
        options.onResync(payload);
      } catch {
        // Ignore malformed frame data
      }
    });

    es.addEventListener("revoked", () => {
      if (source !== es) return;
      closedManually = true;
      awaitingInitialReady = false;
      clearTimer();
      closeSource();
      options.onRevoked();
    });

    es.addEventListener("error", () => {
      if (source !== es || closedManually) return;
      if (es.readyState === 2) {
        closeSource();
        clearTimer();
        const delay = reconnectDelayMs;
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15_000);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!closedManually && activeWorkspaceId === workspaceId) {
            openStream(workspaceId);
          }
        }, delay);
      }
    });
  };

  return {
    connect(workspaceId: WorkspaceId) {
      if (activeWorkspaceId === workspaceId && source && !closedManually) {
        return;
      }
      closedManually = false;
      activeWorkspaceId = workspaceId;
      lastCursor = null;
      awaitingInitialReady = true;
      reconnectDelayMs = 1000;
      clearTimer();
      openStream(workspaceId);
    },

    close() {
      closedManually = true;
      activeWorkspaceId = null;
      lastCursor = null;
      awaitingInitialReady = false;
      clearTimer();
      closeSource();
    },

    getLastCursor() {
      return lastCursor;
    },
  };
}
