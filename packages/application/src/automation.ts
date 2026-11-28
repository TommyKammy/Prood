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
  apply?: boolean;
  reversible?: boolean;
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
export type EffectStatus = "applied" | "skipped" | "denied";
export interface EffectReceipt {
  input: string;
  workspace: string;
  project: string;
  event: string;
  rule: string;
  run: string;
  revision: number;
  task: TaskPublicId;
  field: TaskField;
  before: string | null;
  after: string | null;
  version: number;
  status: EffectStatus;
  decision: "keep" | "undo" | null;
  reason: string;
}
export interface AutomationRepository {
  lockOperation(workspace: string, run: string): Promise<void>;
  routed(
    project: ProjectId,
    task?: TaskPublicId,
    rule?: string,
  ): Promise<{ delivery: Delivery; run: string | null; reason: string | null }[]>;
  members(workspace: WorkspaceId): Promise<{ id: UserId; name: string }[]>;
  events(
    project: ProjectId,
    task?: TaskPublicId,
    rule?: string,
  ): Promise<OutboxEventRecord[]>;
  operationRun(event: string, rule: string): Promise<string | null>;
  receipt(workspace: string, run: string): Promise<EffectReceipt | null>;
  record(effect: EffectReceipt): Promise<void>;
  decide(workspace: string, run: string, decision: "keep" | "undo"): Promise<boolean>;
  confirmed(workspace: string, event: string, rule: string): Promise<string | null>;

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

export function matchesTrigger(
  def: RuleDefinition,
  rule: string,
  eventType: string,
  p: Record<string, unknown>,
) {
  const before = p.before as Record<TaskField, string | null> | undefined;
  const after = p.after as Record<TaskField, string | null> | undefined;

  if (def.when === "manual") {
    if (eventType !== "task.manual" || p.rule !== rule) return false;
  } else if (def.when === "task.created") {
    if (eventType !== "task.created") return false;
  } else {
    if (eventType !== "task.updated" || !before || !after) return false;
    const field = def.when === "status.changed" ? "statusId" : "assigneeId";
    if (
      before[field] === after[field] ||
      (def.from !== undefined && def.from !== before[field]) ||
      (def.to !== undefined && def.to !== after[field])
    )
      return false;
  }
  if (def.ifUnassigned && (after ? after.assigneeId : p.assigneeId) !== null) return false;
  return true;
}
export async function routeTaskEvent(
  repos: TransactionRepositories,
  e: OutboxEventRecord,
  manualSubscription?: Subscription,
  parentDelivery?: Delivery,
) {
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
    const parent =
      parentDelivery ?? (await repos.automation.lookup(e.workspaceId, p.parentRun));
    if (
      !parent ||
      parent.organization !== e.workspaceId ||
      parent.project !== e.projectId ||
      parent.proposal.delegate !== e.actorUserId
    )
      throw Error("Unknown automation parent");
    ancestry = parent.proposal.ancestry;
    cause = p.parentRun;
    origin = parent.proposal.origin;
  }
  // A manual start has already selected a revision. A second read under READ COMMITTED
  // could silently drop it or route it to a revision published in between.
  const subscriptions = manualSubscription
    ? [manualSubscription]
    : await repos.automation.rules(e.projectId);
  for (const r of subscriptions) {
    if (!r.enabled || r.project !== e.projectId) continue;
    const def = r.definition;
    const matches = matchesTrigger(def, r.rule, e.eventType, p);
    if (
      !matches &&
      (!def.apply ||
        !def.ifUnassigned ||
        !matchesTrigger({ ...def, ifUnassigned: false }, r.rule, e.eventType, p))
    )
      continue;
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
    await repos.automation.enqueue(
      d,
      ancestry.includes(r.rule) ? "cycle" : !matches ? "condition" : null,
    );
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
    r.automation.claim(workspace, token, now.toISOString(), new Date(+now + leaseMs).toISOString()),
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
    !onlyKeys(value, ["when", "from", "to", "ifUnassigned", "action", "apply", "reversible"]) ||
    typeof value.when !== "string" ||
    !["task.created", "status.changed", "assignee.changed", "manual"].includes(value.when) ||
    (value.apply !== undefined && typeof value.apply !== "boolean") ||
    (value.reversible !== undefined && (typeof value.reversible !== "boolean" || !value.apply)) ||
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
