import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Sql } from "postgres";
import { appendAudit } from "../modules/audit/audit-writer";
import type { SecretService } from "../modules/identity/secret-service";
import { createSecretServiceFromEnvironment } from "../modules/identity/secret-service";
import { createDatabase, withTransaction } from "./client";
import { databaseConfig } from "./config";

export interface InitialSuperadminInput {
  email: string;
  firstName: string;
  lastName: string;
  organizationCode: string;
  organizationName: string;
}

export async function persistSetupToken(filePath: string, setupToken: string): Promise<void> {
  await writeFile(filePath, `${setupToken}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function withProtectedSetupTokenFile<T>(
  filePath: string,
  setupToken: string,
  work: () => Promise<T>,
): Promise<T> {
  await persistSetupToken(filePath, setupToken);
  try {
    return await work();
  } catch (error) {
    await rm(filePath, { force: true });
    throw error;
  }
}

export async function bootstrapInitialSuperadmin(
  sql: Sql,
  secrets: SecretService,
  input: InitialSuperadminInput,
  suppliedSetupToken?: string,
): Promise<{ userId: string; setupToken: string }> {
  return withTransaction(sql, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('initial_superadmin'))`;
    const [{ count }] = await tx<{ count: number }[]>`
      select count(*)::int as count from users where role = 'superadmin'
    `;
    if (count > 0) throw new Error("Initial superadministrator already exists");

    const email = input.email.trim().toLowerCase();
    const [organization] = await tx<{ id: string }[]>`
      insert into organizations (code, name)
      values (${input.organizationCode.trim()}, ${input.organizationName.trim()})
      on conflict (code) do update set name = excluded.name, active = true
      returning id
    `;
    const [user] = await tx<{ id: string }[]>`
      insert into users (
        organization_id, first_name, last_name, email, role, status
      ) values (
        ${organization.id}, ${input.firstName.trim()}, ${input.lastName.trim()},
        ${email}, 'superadmin', 'invited'
      ) returning id
    `;
    const setupToken = suppliedSetupToken ?? secrets.newSessionToken();
    await tx`
      insert into admin_credentials (user_id, password_hash)
      values (${user.id}, ${await secrets.hashPassword(secrets.newSessionToken())})
    `;
    await tx`
      insert into login_challenges (user_id, kind, secret_hash, expires_at)
      values (
        ${user.id}, 'set_password', ${secrets.hashSessionToken(setupToken)},
        now() + interval '30 minutes'
      )
    `;
    await appendAudit(tx, {
      actor: null,
      action: "system.initial_superadmin_created",
      targetType: "user",
      targetId: user.id,
      correlationId: crypto.randomUUID(),
      metadata: { email },
    }, "allowed");
    return { userId: user.id, setupToken };
  });
}

async function main() {
  if (existsSync(".env.local") && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(".env.local");
  }
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const sql = createDatabase(databaseConfig().databaseUrl);
  try {
    const tokenFile = required("FIRST_ADMIN_TOKEN_FILE");
    const secrets = createSecretServiceFromEnvironment();
    const setupToken = secrets.newSessionToken();
    await withProtectedSetupTokenFile(tokenFile, setupToken, () =>
      bootstrapInitialSuperadmin(
        sql,
        secrets,
        {
          email: required("FIRST_ADMIN_EMAIL"),
          firstName: required("FIRST_ADMIN_FIRST_NAME"),
          lastName: required("FIRST_ADMIN_LAST_NAME"),
          organizationCode: required("FIRST_ADMIN_ORGANIZATION_CODE"),
          organizationName: required("FIRST_ADMIN_ORGANIZATION_NAME"),
        },
        setupToken,
      ),
    );
    process.stdout.write(`Initial superadministrator created. Setup token written to ${tokenFile}.\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
