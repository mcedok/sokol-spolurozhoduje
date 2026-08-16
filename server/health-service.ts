import type { Sql } from "postgres";

export async function databaseIsReady(sql: Sql, timeoutMs = 2_000): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sql`select 1`,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Readiness timeout")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
