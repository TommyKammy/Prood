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

/**
 * Applies an incoming SSE task change event onto the currently rendered project's
 * task array without mutating the source array. Cascades parent deletions to any
 * rendered descendants and flags `needsReload` on parent moves affecting the view.
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
  if (event.eventType === "task.deleted" || event.eventType === "task.removed") {
    if (!targetId) {
      return { tasks: [...tasks], changed: false };
    }
    const next = removeTaskSubtree(tasks, targetId);
    return {
      tasks: next,
      changed: next.length !== tasks.length,
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
          ? removeTaskSubtree(tasks, incoming.id)
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
  onChange: (event: RealtimeChangeEventDto) => void;
  onResync: (event: RealtimeResyncEventDto) => void;
  onRevoked: () => void;
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
      const msg = rawEvent as MessageEvent<string>;
      try {
        const payload = JSON.parse(msg.data) as RealtimeReadyEventDto;
        const cursor = msg.lastEventId || payload.cursor;
        if (cursor) {
          lastCursor = cursor;
        }
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
      reconnectDelayMs = 1000;
      clearTimer();
      openStream(workspaceId);
    },

    close() {
      closedManually = true;
      activeWorkspaceId = null;
      lastCursor = null;
      clearTimer();
      closeSource();
    },

    getLastCursor() {
      return lastCursor;
    },
  };
}
