import type { Sql } from "postgres";
import { createDatabase } from "./db/client";
import { databaseConfig } from "./db/config";
import { createAuthService } from "./modules/identity/auth-service";
import { createSecretServiceFromEnvironment, type SecretService } from "./modules/identity/secret-service";
import { createTotpVaultFromEnvironment } from "./modules/identity/totp-vault";

export interface IdentityRuntime {
  sql: Sql;
  secrets: SecretService;
  auth: ReturnType<typeof createAuthService>;
}

let identityRuntime: IdentityRuntime | undefined;

export function getIdentityRuntime(): IdentityRuntime {
  if (identityRuntime) return identityRuntime;
  const sql = createDatabase(databaseConfig().databaseUrl);
  const secrets = createSecretServiceFromEnvironment();
  identityRuntime = {
    sql,
    secrets,
    auth: createAuthService({
      sql,
      secrets,
      totp: createTotpVaultFromEnvironment(),
      exposeTestSecrets: false,
    }),
  };
  return identityRuntime;
}
