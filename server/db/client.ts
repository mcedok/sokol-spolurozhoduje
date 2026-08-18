import postgres, { type Sql } from "postgres";

export function createDatabase(url: string): Sql {
  if (!url) throw new Error("DATABASE_URL is required");
  return postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export async function withTransaction<T>(
  sql: Sql,
  work: (transaction: Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (transaction) => work(transaction as unknown as Sql)) as Promise<T>;
}
