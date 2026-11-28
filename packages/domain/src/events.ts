import type { UserId } from "./id.js";

export const OUTBOX_SCHEMA_VERSION = 1 as const;

export type EventOutcome = "succeeded" | "denied";
export type ActorType = "user" | "agent" | "anonymous" | "system";
export type EventChannel = "web" | "mcp" | "api" | "automation" | "system";

export interface AuditActorContext {
  userId: UserId | null;
  actorType: ActorType;
  channel: EventChannel;
  clientId?: string;
  /** Trusted automation worker context; never read from a Web or MCP task patch. */
  parentRun?: string;
}
