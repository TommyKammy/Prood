import {
  CONTRACT_VERSION,
  type ApiErrorCode,
  type RealtimeChangeEventDto,
  type RealtimeChangeKind,
} from "@prood/contracts";
import {
  canReadProject,
  isValidEntityId,
  OUTBOX_SCHEMA_VERSION,
  type AuditActorContext,
  type ProjectId,
  type TaskPublicId,
  type WorkspaceId,
} from "@prood/domain";
import type { IdGenerator } from "./id.js";
import type { Clock } from "./index.js";
import type {
  ProjectRecord,
  TransactionRepositories,
  UnitOfWork,
} from "./persistence.js";
import {
  advanceRealtimeCursor,
  buildInitialCursor,
  encodeRealtimeCursor,
  isCursorExpired,
  MAX_PENDING_XIPS,
  parseRealtimeCursor,
  stepRealtimeCursorForEvent,
  type ParsedRealtimeCursor,
} from "./realtime-cursor.js";
import {
  resolveActorProjectRole,
  resolveAssigneeDisplayNames,
  resolveTaskEffectiveProject,
  toTaskDto,
} from "./work-helpers.js";

const DEFAULT_POLL_LIMIT = 100;

export const REALTIME_EVENT_TYPES = new Set<string>([
  "task.created",
  "task.updated",
  "task.started",
  "task.moved",
  "task.deleted",
  "project.created",
  "project.dev_enabled",
  "project.dev_settings.updated",
  "project.status.updated",
  "project.status.deleted",
  "workspace.settings.updated",
]);

/**
 * In-process post-commit notification hub to wake SSE subscribers cleanly.
 */
export interface RealtimeHub {
  subscribe(workspaceId: WorkspaceId, listener: () => void): () => void;
  notify(workspaceId: WorkspaceId): void;
}

/**
 * Creates a pure-JS post-commit notification hub with zero Node builtins.
 */
export function createRealtimeHub(): RealtimeHub {
  const listenersByWorkspace = new Map<WorkspaceId, Set<() => void>>();

  return {
    subscribe(workspaceId: WorkspaceId, listener: () => void): () => void {
      let set = listenersByWorkspace.get(workspaceId);
      if (!set) {
        set = new Set();
        listenersByWorkspace.set(workspaceId, set);
      }
      set.add(listener);
      return () => {
        const current = listenersByWorkspace.get(workspaceId);
        if (!current) {
          return;
        }
        current.delete(listener);
        if (current.size === 0) {
          listenersByWorkspace.delete(workspaceId);
        }
      };
    },

    notify(workspaceId: WorkspaceId): void {
      const set = listenersByWorkspace.get(workspaceId);
      if (!set) {
        return;
      }
      for (const listener of Array.from(set)) {
        try {
          listener();
        } catch {
          // Listener cleanup should never disrupt other subscribers
        }
      }
    },
  };
}

export interface RealtimeUseCaseDeps {
  uow: UnitOfWork;
  clock: Clock;
  idGenerator: IdGenerator;
  retentionMs?: number;
  maxEvents?: number;
}

export type OpenSubscriptionResult =
  | {
      ok: false;
      status: 403 | 404;
      code: ApiErrorCode;
      messageKey: string;
    }
  | {
      ok: true;
      mode: "ready" | "resume";
      cursor: string;
      parsedCursor: ParsedRealtimeCursor;
    }
  | {
      ok: true;
      mode: "resync";
      reason: "cursor_expired" | "cursor_invalid";
      cursor: string;
      parsedCursor: ParsedRealtimeCursor;
    };

export type PollSubscriptionResult =
  | { status: "revoked" }
  | {
      status: "resync";
      reason: "cursor_expired";
      cursor: string;
      parsedCursor: ParsedRealtimeCursor;
    }
  | {
      status: "ok";
      items: RealtimeChangeEventDto[];
      nextCursor: ParsedRealtimeCursor;
      nextCursorEncoded: string;
      hasMore: boolean;
    };

/**
 * Application use cases for authorized cursor-based SSE subscriptions, commit-order
 * safe polling, live re-authorization, and retention pruning.
 */
export function createRealtimeUseCases(deps: RealtimeUseCaseDeps) {
  function buildPruneInput() {
    const now = deps.clock.now();
    const beforeCreatedAt =
      deps.retentionMs !== undefined && Number.isFinite(deps.retentionMs) && deps.retentionMs > 0
        ? new Date(now.getTime() - deps.retentionMs).toISOString()
        : undefined;
    const keepLast =
      deps.maxEvents !== undefined && Number.isFinite(deps.maxEvents) && deps.maxEvents >= 0
        ? Math.trunc(deps.maxEvents)
        : undefined;
    return {
      beforeCreatedAt,
      keepLast,
      nowIso: now.toISOString(),
    };
  }

  async function recordSubscribeDenial(
    repos: TransactionRepositories,
    workspaceId: WorkspaceId | null,
    projectId: ProjectId | null,
    actor: AuditActorContext,
    targetType: "workspace" | "project",
    targetId: string,
    reasonCode: "FORBIDDEN",
  ): Promise<void> {
    const nowIso = deps.clock.now().toISOString();
    await repos.outbox.append({
      id: deps.idGenerator.next("out"),
      eventId: deps.idGenerator.next("evt"),
      schemaVersion: OUTBOX_SCHEMA_VERSION,
      workspaceId,
      projectId,
      eventType: "realtime.subscribe.denied",
      action: "realtime.subscribe",
      outcome: "denied",
      actorUserId: actor.userId,
      actorType: actor.actorType,
      channel: actor.channel,
      targetType,
      targetId,
      reasonCode,
      payload: {
        schemaVersion: OUTBOX_SCHEMA_VERSION,
        ...(workspaceId ? { workspaceId } : {}),
        ...(projectId ? { projectId } : {}),
      },
      occurredAt: nowIso,
    });
  }

  return {
    async openSubscription(
      actor: AuditActorContext,
      workspaceId: WorkspaceId,
      options: { projectId?: ProjectId | null; cursor?: string | null } = {},
    ): Promise<OpenSubscriptionResult> {
      const requestedProjectId = options.projectId ?? null;
      return deps.uow.run(async (repos) => {
        const wsMembership = actor.userId
          ? await repos.memberships.findByWorkspaceAndUser(workspaceId, actor.userId)
          : null;
        if (!wsMembership) {
          await recordSubscribeDenial(
            repos,
            null,
            null,
            actor,
            "workspace",
            workspaceId,
            "FORBIDDEN",
          );
          return {
            ok: false,
            status: 403,
            code: "FORBIDDEN",
            messageKey: "error.forbidden",
          };
        }

        if (requestedProjectId) {
          const project = await repos.projects.findById(requestedProjectId);
          if (!project || project.workspaceId !== workspaceId) {
            return {
              ok: false,
              status: 404,
              code: "NOT_FOUND",
              messageKey: "error.notFound",
            };
          }
          const role = await resolveActorProjectRole(repos, actor.userId, project);
          if (!canReadProject(role)) {
            await recordSubscribeDenial(
              repos,
              workspaceId,
              project.id,
              actor,
              "project",
              project.id,
              "FORBIDDEN",
            );
            return {
              ok: false,
              status: 404,
              code: "NOT_FOUND",
              messageKey: "error.notFound",
            };
          }
        }

        const pruneInput = buildPruneInput();
        if (pruneInput.beforeCreatedAt !== undefined || pruneInput.keepLast !== undefined) {
          await repos.realtimeEvents.prune(pruneInput);
        }

        const snapshot = await repos.realtimeEvents.readSnapshotState(workspaceId);
        const freshCursor = buildInitialCursor(workspaceId, snapshot);
        const freshEncoded = encodeRealtimeCursor(freshCursor);

        if (!options.cursor || options.cursor.trim() === "") {
          return {
            ok: true,
            mode: "ready",
            cursor: freshEncoded,
            parsedCursor: freshCursor,
          };
        }

        const parsed = parseRealtimeCursor(options.cursor, snapshot.driver, workspaceId);
        if (!parsed) {
          return {
            ok: true,
            mode: "resync",
            reason: "cursor_invalid",
            cursor: freshEncoded,
            parsedCursor: freshCursor,
          };
        }

        if (isCursorExpired(parsed, snapshot)) {
          return {
            ok: true,
            mode: "resync",
            reason: "cursor_expired",
            cursor: freshEncoded,
            parsedCursor: freshCursor,
          };
        }

        return {
          ok: true,
          mode: "resume",
          cursor: encodeRealtimeCursor(parsed),
          parsedCursor: parsed,
        };
      });
    },

    async pollSubscription(
      actor: AuditActorContext,
      workspaceId: WorkspaceId,
      parsedCursor: ParsedRealtimeCursor,
      options: { projectId?: ProjectId | null; limit?: number } = {},
    ): Promise<PollSubscriptionResult> {
      const requestedProjectId = options.projectId ?? null;
      const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? DEFAULT_POLL_LIMIT)));

      return deps.uow.run(async (repos) => {
        const wsMembership = actor.userId
          ? await repos.memberships.findByWorkspaceAndUser(workspaceId, actor.userId)
          : null;
        if (!wsMembership) {
          return { status: "revoked" };
        }

        const projectAccessCache = new Map<
          ProjectId,
          { project: ProjectRecord | null; readable: boolean }
        >();
        async function getProjectAccess(
          projectId: ProjectId | null,
        ): Promise<{ project: ProjectRecord | null; readable: boolean }> {
          if (!projectId) {
            return { project: null, readable: false };
          }
          const cached = projectAccessCache.get(projectId);
          if (cached) {
            return cached;
          }
          const project = await repos.projects.findById(projectId);
          if (!project || project.workspaceId !== workspaceId) {
            const miss = { project: null, readable: false };
            projectAccessCache.set(projectId, miss);
            return miss;
          }
          const role = await resolveActorProjectRole(repos, actor.userId, project);
          const entry = { project, readable: canReadProject(role) };
          projectAccessCache.set(projectId, entry);
          return entry;
        }

        if (requestedProjectId) {
          const scopedAccess = await getProjectAccess(requestedProjectId);
          if (!scopedAccess.readable) {
            return { status: "revoked" };
          }
        }

        const pruneInput = buildPruneInput();
        if (pruneInput.beforeCreatedAt !== undefined || pruneInput.keepLast !== undefined) {
          await repos.realtimeEvents.prune(pruneInput);
        }

        const { snapshot, events } = await repos.realtimeEvents.listAfterPosition({
          workspaceId,
          watermarkTxid: parsedCursor.watermarkTxid.toString(),
          watermarkSeq: parsedCursor.watermarkSeq,
          pendingTxids: parsedCursor.pending.map((entry) => ({
            txid: entry.txid.toString(),
            afterSeq: entry.afterSeq,
          })),
          limit,
        });

        if (isCursorExpired(parsedCursor, snapshot)) {
          const fresh = buildInitialCursor(workspaceId, snapshot);
          return {
            status: "resync",
            reason: "cursor_expired",
            cursor: encodeRealtimeCursor(fresh),
            parsedCursor: fresh,
          };
        }

        const items: RealtimeChangeEventDto[] = [];
        let runningCursor = parsedCursor;

        for (const ev of events) {
          runningCursor = stepRealtimeCursorForEvent(runningCursor, ev, snapshot);
          if (runningCursor.pending.length > MAX_PENDING_XIPS) {
            const fresh = buildInitialCursor(workspaceId, snapshot);
            return {
              status: "resync",
              reason: "cursor_expired",
              cursor: encodeRealtimeCursor(fresh),
              parsedCursor: fresh,
            };
          }
          const itemCursor = encodeRealtimeCursor(runningCursor);

          if (ev.eventType === "workspace.settings.updated") {
            items.push({
              contractVersion: CONTRACT_VERSION,
              type: "change",
              eventId: ev.eventId,
              eventType: "workspace.settings.updated",
              workspaceId,
              projectId: null,
              occurredAt: ev.occurredAt,
              cursor: itemCursor,
            });
            continue;
          }

          if (
            ev.eventType === "project.created" ||
            ev.eventType === "project.dev_enabled" ||
            ev.eventType === "project.dev_settings.updated" ||
            ev.eventType === "project.status.updated" ||
            ev.eventType === "project.status.deleted"
          ) {
            const access = await getProjectAccess(ev.projectId);
            if (!access.readable || !access.project) {
              continue;
            }
            if (requestedProjectId && access.project.id !== requestedProjectId) {
              continue;
            }
            items.push({
              contractVersion: CONTRACT_VERSION,
              type: "change",
              eventId: ev.eventId,
              eventType: ev.eventType as RealtimeChangeKind,
              workspaceId,
              projectId: access.project.id,
              occurredAt: ev.occurredAt,
              cursor: itemCursor,
            });
            continue;
          }

          if (ev.eventType === "task.deleted") {
            const taskId =
              ev.targetId && isValidEntityId("tsk", ev.targetId)
                ? (ev.targetId as TaskPublicId)
                : undefined;
            const access = await getProjectAccess(ev.projectId);
            if (!access.readable || !access.project) {
              continue;
            }
            if (requestedProjectId && access.project.id !== requestedProjectId) {
              continue;
            }
            items.push({
              contractVersion: CONTRACT_VERSION,
              type: "change",
              eventId: ev.eventId,
              eventType: "task.deleted",
              workspaceId,
              projectId: access.project.id,
              ...(taskId ? { taskId } : {}),
              occurredAt: ev.occurredAt,
              cursor: itemCursor,
            });
            continue;
          }

          if (
            ev.eventType === "task.created" ||
            ev.eventType === "task.updated" ||
            ev.eventType === "task.started" ||
            ev.eventType === "task.moved"
          ) {
            if (!ev.targetId || !isValidEntityId("tsk", ev.targetId)) {
              continue;
            }
            const taskId = ev.targetId as TaskPublicId;
            const task = await repos.tasks.findById(taskId);
            const rawFromProjectId =
              ev.eventType === "task.moved" &&
              typeof ev.payload.fromProjectId === "string" &&
              isValidEntityId("prj", ev.payload.fromProjectId)
                ? (ev.payload.fromProjectId as ProjectId)
                : null;

            if (!task || task.workspaceId !== workspaceId) {
              // If a moved task was subsequently deleted before streaming, authorize
              // against its `fromProjectId` so readable source projects still remove it
              // without disclosing anything about an inaccessible target project.
              if (ev.eventType === "task.moved" && rawFromProjectId) {
                const fromAccess = await getProjectAccess(rawFromProjectId);
                if (
                  fromAccess.readable &&
                  fromAccess.project &&
                  (!requestedProjectId || fromAccess.project.id === requestedProjectId)
                ) {
                  items.push({
                    contractVersion: CONTRACT_VERSION,
                    type: "change",
                    eventId: ev.eventId,
                    eventType: "task.removed",
                    workspaceId,
                    projectId: fromAccess.project.id,
                    taskId,
                    occurredAt: ev.occurredAt,
                    cursor: itemCursor,
                  });
                }
              }
              continue;
            }

            const effective = await resolveTaskEffectiveProject(repos, task);
            if (!effective || effective.project.workspaceId !== workspaceId) {
              continue;
            }
            const targetAccess = await getProjectAccess(effective.project.id);
            const fromAccess =
              ev.eventType === "task.moved" && rawFromProjectId
                ? await getProjectAccess(rawFromProjectId)
                : { project: null, readable: false };

            if (!targetAccess.readable) {
              // Task moved (or lives) in an unreadable private project:
              // never leak target project details. If subscriber could read `fromProjectId`,
              // emit a sanitized removal for that source project only.
              if (
                ev.eventType === "task.moved" &&
                fromAccess.readable &&
                fromAccess.project &&
                (!requestedProjectId || fromAccess.project.id === requestedProjectId)
              ) {
                items.push({
                  contractVersion: CONTRACT_VERSION,
                  type: "change",
                  eventId: ev.eventId,
                  eventType: "task.removed",
                  workspaceId,
                  projectId: fromAccess.project.id,
                  taskId: task.id,
                  occurredAt: ev.occurredAt,
                  cursor: itemCursor,
                });
              }
              continue;
            }

            const matchesRequestedProject =
              !requestedProjectId ||
              effective.project.id === requestedProjectId ||
              (fromAccess.readable && rawFromProjectId === requestedProjectId);
            if (!matchesRequestedProject) {
              continue;
            }

            const [issueKey, activeNamespace, assigneeNames] = await Promise.all([
              repos.issueKeys.findByTaskId(task.id),
              repos.issueKeys.findNamespaceByProjectId(effective.project.id),
              resolveAssigneeDisplayNames(repos, [task]),
            ]);
            const taskDto = toTaskDto(
              task,
              effective.project.id,
              issueKey,
              activeNamespace !== null,
              task.assigneeId ? (assigneeNames.get(task.assigneeId) ?? null) : null,
            );

            items.push({
              contractVersion: CONTRACT_VERSION,
              type: "change",
              eventId: ev.eventId,
              eventType: ev.eventType as RealtimeChangeKind,
              workspaceId,
              projectId: effective.project.id,
              ...(ev.eventType === "task.moved" && fromAccess.readable && rawFromProjectId
                ? { fromProjectId: rawFromProjectId }
                : {}),
              taskId: task.id,
              task: taskDto,
              occurredAt: ev.occurredAt,
              cursor: itemCursor,
            });
          }
        }

        const advanced = advanceRealtimeCursor(parsedCursor, events, snapshot, limit);
        if (advanced.overflow) {
          const fresh = buildInitialCursor(workspaceId, snapshot);
          return {
            status: "resync",
            reason: "cursor_expired",
            cursor: encodeRealtimeCursor(fresh),
            parsedCursor: fresh,
          };
        }
        return {
          status: "ok",
          items,
          nextCursor: advanced.cursor,
          nextCursorEncoded: encodeRealtimeCursor(advanced.cursor),
          hasMore: events.length === limit,
        };
      });
    },

    async pruneRealtimeEvents(input: {
      beforeCreatedAt?: string;
      keepLast?: number;
    }): Promise<{
      deletedCount: number;
      prunedThroughTxid: string;
      prunedThroughSeq: number;
    }> {
      return deps.uow.run((repos) =>
        repos.realtimeEvents.prune({
          ...input,
          nowIso: deps.clock.now().toISOString(),
        }),
      );
    },
  };
}
