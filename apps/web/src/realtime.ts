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
  highlightedTaskId?: TaskPublicId | null;
}

function compareTasks(a: TaskDto, b: TaskDto): number {
  return (
    a.position - b.position ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Applies an incoming SSE task change event onto the currently rendered project's
 * task array without mutating the source array.
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
    const next = tasks.filter((item) => item.id !== targetId);
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
    if (!incoming) {
      return { tasks: [...tasks], changed: false };
    }
    const existingIndex = tasks.findIndex((item) => item.id === incoming.id);
    if (incoming.effectiveProjectId !== activeProjectId) {
      if (existingIndex === -1) {
        return { tasks: [...tasks], changed: false };
      }
      return {
        tasks: tasks.filter((_, idx) => idx !== existingIndex),
        changed: true,
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
    };
  }

  return { tasks: [...tasks], changed: false };
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
