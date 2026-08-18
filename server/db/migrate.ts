import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Sql } from "postgres";
import { createDatabase } from "./client";
import { databaseConfig } from "./config";

function resolveMigrationsDirectory(): string {
  const moduleUrl = new URL(import.meta.url);
  if (moduleUrl.protocol === "file:") {
    return resolve(dirname(fileURLToPath(moduleUrl)), "migrations");
  }

  const projectRoot = process.env.SOKOL_PROJECT_ROOT ?? process.cwd();
  return resolve(projectRoot, "server/db/migrations");
}

export async function runMigrations({
  sql,
  migrationsDirectory = resolveMigrationsDirectory(),
}: {
  sql: Sql;
  migrationsDirectory?: string;
}): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((fileName) => /^\d+_[a-z0-9_]+\.sql$/.test(fileName))
    .sort();

  for (const fileName of migrationFiles) {
    const [applied] = await sql<{ exists: boolean }[]>`
      select exists(select 1 from schema_migrations where version = ${fileName}) as exists
    `;
    if (applied.exists) continue;

    const migrationSql = await readFile(`${migrationsDirectory}/${fileName}`, "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(migrationSql);
      await transaction`
        insert into schema_migrations (version) values (${fileName})
      `;
    });
  }
}

async function runFromCommandLine(): Promise<void> {
  const { databaseUrl } = databaseConfig();
  const sql = createDatabase(databaseUrl);
  try {
    await runMigrations({ sql });
  } finally {
    await sql.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  await runFromCommandLine();
}
