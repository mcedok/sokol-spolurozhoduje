import type { Sql } from "postgres";
import type { Actor } from "../../../contracts";
import { withTransaction } from "../../db/client";
import { appendAudit } from "../audit/audit-writer";

export interface CommandContext {
  actor: Actor | null;
  action: string;
  targetType: string;
  targetId?: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

export async function executeCommand<T>(
  sql: Sql,
  context: CommandContext,
  work: (tx: Sql) => Promise<T>,
): Promise<T> {
  return withTransaction(sql, async (tx) => {
    const result = await work(tx);
    await appendAudit(tx, context, "allowed");
    return result;
  });
}
