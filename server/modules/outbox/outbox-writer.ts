import type { Sql } from "postgres";

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface OutboxInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export async function appendOutbox(tx: Sql, input: OutboxInput): Promise<void> {
  const payload = JSON.parse(JSON.stringify(input.payload)) as JsonValue;
  await tx`
    insert into outbox_events (
      event_type, aggregate_type, aggregate_id, payload, idempotency_key
    ) values (
      ${input.eventType}, ${input.aggregateType}, ${input.aggregateId},
      ${tx.json(payload)}, ${input.idempotencyKey}
    )
    on conflict (idempotency_key) do nothing
  `;
}
