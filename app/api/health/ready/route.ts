import type { Sql } from "postgres";
import { createDatabase } from "../../../../server/db/client";
import { databaseConfig } from "../../../../server/db/config";
import { databaseIsReady } from "../../../../server/health-service";

let healthSql: Sql | undefined;

function database(): Sql {
  healthSql ??= createDatabase(databaseConfig().databaseUrl);
  return healthSql;
}

export async function GET() {
  const ready = await databaseIsReady(database());
  return Response.json(
    { status: ready ? "ready" : "unavailable" },
    {
      status: ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
