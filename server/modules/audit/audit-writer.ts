import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { Actor } from "../../../contracts";
import { withTransaction } from "../../db/client";

const SECRET_KEY = /password|secret|token|cookie|authorization|code/i;

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface AuditInput {
  actor: Actor | null;
  action: string;
  targetType: string;
  targetId?: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

export type AuditOutcome = "allowed" | "denied";

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : sanitize(nestedValue),
      ]),
  );
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => `${JSON.stringify(key)}:${canonicalJson(nestedValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function appendAudit(
  tx: Sql,
  input: AuditInput,
  outcome: AuditOutcome,
): Promise<void> {
  const metadata = toJsonValue(sanitize(input.metadata ?? {})) as {
    [key: string]: JsonValue;
  };
  await tx`select pg_advisory_xact_lock(hashtext('audit_events'))`;
  const [previous] = await tx<{ event_hash: string }[]>`
    select event_hash from audit_events order by created_at desc, id desc limit 1
  `;
  const previousHash = previous?.event_hash ?? null;
  const canonicalEvent = canonicalJson({
    action: input.action,
    actorRole: input.actor?.role ?? null,
    actorUserId: input.actor?.userId ?? null,
    correlationId: input.correlationId,
    metadata,
    outcome,
    previousHash,
    targetId: input.targetId ?? null,
    targetType: input.targetType,
  });
  const eventHash = createHash("sha256")
    .update(`${previousHash ?? ""}${canonicalEvent}`)
    .digest("hex");

  await tx`
    insert into audit_events (
      actor_user_id, actor_role, action, target_type, target_id, outcome,
      correlation_id, metadata, previous_hash, event_hash
    ) values (
      ${input.actor?.userId ?? null}, ${input.actor?.role ?? null}, ${input.action},
      ${input.targetType}, ${input.targetId ?? null}, ${outcome},
      ${input.correlationId}, ${tx.json(metadata)}, ${previousHash}, ${eventHash}
    )
  `;
}

export async function appendDeniedAudit(sql: Sql, input: AuditInput): Promise<void> {
  await withTransaction(sql, async (tx) => appendAudit(tx, input, "denied"));
}
