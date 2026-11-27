import type { ProjectId, TaskPublicId, UserId, WorkspaceId } from "@prood/domain";
import type {
  Clock,
  IdGenerator,
  OutboxEventRecord,
  TransactionRepositories,
  UnitOfWork,
} from "./index.js";

export type TaskField = "statusId" | "assigneeId";
export interface RuleDefinition {
  when: "task.created" | "status.changed" | "assignee.changed" | "manual";
  from?: string | null;
  to?: string | null;
  ifUnassigned?: boolean;
  action: { field: TaskField; value: string | null | { event: TaskField } };
}
export interface Subscription {
  project: ProjectId;
  rule: string;
  revision: number;
  actor: UserId;
  delegation: number;
  enabled: boolean;
  definition: RuleDefinition;
}
export interface Proposal {
  task: TaskPublicId;
  version: number | null;
  fields: Record<TaskField, string | null>;
  origin: UserId | null;
  delegate: UserId;
  delegation: number;
  definition: RuleDefinition;
  ancestry: string[];
  cause: string | null;
}
export interface Delivery {
  organization: WorkspaceId;
  project: ProjectId;
  event: string;
  rule: string;
  revision: number;
  proposal: Proposal;
}
export interface AutomationRepository {
  rules(project: ProjectId): Promise<Subscription[]>;
  save(rule: Subscription, expected: number): Promise<boolean>;
  enqueue(d: Delivery, reason: string | null): Promise<void>;
  claim(
    workspace: WorkspaceId,
    token: string,
    now: string,
    expires: string,
  ): Promise<Delivery | null>;
  confirm(d: Delivery, token: string, run: string, now: string): Promise<boolean>;
  intent(workspace: WorkspaceId, event: string, rule: string): Promise<Delivery | null>;
  firstCheck(d: Delivery, run: string, status: string): Promise<boolean>;
  lookup(workspace: WorkspaceId, run: string): Promise<Delivery | null>;
}

export async function routeTaskEvent(repos: TransactionRepositories, e: OutboxEventRecord) {
  if (
    !e.projectId ||
    !e.workspaceId ||
    !e.targetId ||
    e.outcome !== "succeeded" ||
    !["task.created", "task.updated", "task.manual"].includes(e.eventType)
  )
    return;
  const p = e.payload;
  const before = p.before as Record<TaskField, string | null> | undefined;
  const after = p.after as Record<TaskField, string | null> | undefined;
  // Only committed automation runs may extend a causal chain. Ordinary Web/MCP events start fresh.
  let ancestry: string[] = [];
  let cause: string | null = null;
  let origin = e.actorUserId;
  if (e.channel === "automation") {
    if (typeof p.parentRun !== "string") throw Error("Missing automation parent");
    const parent = await repos.automation.lookup(e.workspaceId, p.parentRun);
    if (
      !parent ||
      parent.project !== e.projectId ||
      parent.proposal.delegate !== e.actorUserId
    )
      throw Error("Unknown automation parent");
    ancestry = parent.proposal.ancestry;
    cause = p.parentRun;
    origin = parent.proposal.origin;
  }
  for (const r of await repos.automation.rules(e.projectId)) {
    if (!r.enabled) continue;
    const def = r.definition;
    if (def.when === "manual") {
      if (e.eventType !== "task.manual" || p.rule !== r.rule) continue;
    } else if (def.when === "task.created") {
      if (e.eventType !== "task.created") continue;
    } else {
      if (e.eventType !== "task.updated" || !before || !after) continue;
      const field = def.when === "status.changed" ? "statusId" : "assigneeId";
      if (
        before[field] === after[field] ||
        (def.from !== undefined && def.from !== before[field]) ||
        (def.to !== undefined && def.to !== after[field])
      )
        continue;
    }
    if (def.ifUnassigned && (after ? after.assigneeId : p.assigneeId) !== null) continue;
    const d: Delivery = {
      organization: e.workspaceId,
      project: e.projectId,
      event: e.eventId,
      rule: r.rule,
      revision: r.revision,
      proposal: {
        task: e.targetId as TaskPublicId,
        version:
          typeof p.taskVersion === "number" && Number.isSafeInteger(p.taskVersion)
            ? p.taskVersion
            : null,
        origin,
        fields: {
          statusId: after ? after.statusId : ((p.statusId as string) ?? null),
          assigneeId: after ? after.assigneeId : ((p.assigneeId as string) ?? null),
        },
        delegate: r.actor,
        delegation: r.delegation,
        definition: def,
        ancestry: [...ancestry, r.rule],
        cause,
      },
    };
    await repos.automation.enqueue(d, ancestry.includes(r.rule) ? "cycle" : null);
  }
}

// A unit of work ends before the transport call. A stale lease cannot acknowledge a new owner's receipt.
export async function deliverNext(
  deps: { uow: UnitOfWork; clock: Clock; idGenerator: IdGenerator },
  workspace: WorkspaceId,
  accept: (delivery: Delivery) => Promise<string> | string,
  leaseMs = 30000,
) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw Error("Invalid delivery lease");
  const token = deps.idGenerator.next("out");
  const now = deps.clock.now();
  const delivery = await deps.uow.run((r) =>
    r.automation.claim(
      workspace,
      token,
      now.toISOString(),
      new Date(+now + leaseMs).toISOString(),
    ),
  );
  if (!delivery) return false;
  const run = await accept(delivery);
  if (!run) throw Error("Missing durable receipt");
  return deps.uow.run((r) =>
    r.automation.confirm(delivery, token, run, deps.clock.now().toISOString()),
  );
}

function onlyKeys(value: unknown, allowed: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((k) => allowed.includes(k))
  );
}
// Closed vocabulary shared by preview, publication and import. No executable graph is accepted.
export function parseRule(value: unknown): RuleDefinition | null {
  if (
    !onlyKeys(value, ["when", "from", "to", "ifUnassigned", "action"]) ||
    typeof value.when !== "string" ||
    !["task.created", "status.changed", "assignee.changed", "manual"].includes(value.when) ||
    (value.ifUnassigned !== undefined && typeof value.ifUnassigned !== "boolean") ||
    !onlyKeys(value.action, ["field", "value"]) ||
    typeof value.action.field !== "string" ||
    !["statusId", "assigneeId"].includes(value.action.field)
  )
    return null;
  const action = value.action;
  if (
    action.value !== null &&
    typeof action.value !== "string" &&
    !(onlyKeys(action.value, ["event"]) && action.value.event === action.field)
  )
    return null;
  for (const key of ["from", "to"]) {
    if (!(key in value)) continue;
    if (value.when !== "status.changed" && value.when !== "assignee.changed") return null;
    if (value[key] !== null && typeof value[key] !== "string") return null;
  }
  return value as unknown as RuleDefinition;
}
