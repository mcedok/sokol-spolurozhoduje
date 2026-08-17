import type { Sql } from "postgres";
import { createDatabase } from "./db/client";
import { databaseConfig } from "./db/config";
import { createAuthService } from "./modules/identity/auth-service";
import { createSecretServiceFromEnvironment, type SecretService } from "./modules/identity/secret-service";
import { createTotpVaultFromEnvironment } from "./modules/identity/totp-vault";
import { createUserService } from "./modules/identity/user-service";
import { createDocumentService } from "./modules/documents/document-service";
import { createAzureBlobStorage } from "./modules/files/azure-blob-storage";
import { fileConfig } from "./modules/files/file-config";

export interface IdentityRuntime {
  sql: Sql;
  secrets: SecretService;
  auth: ReturnType<typeof createAuthService>;
  users: ReturnType<typeof createUserService>;
  documents: ReturnType<typeof createDocumentService>;
  files: ReturnType<typeof createAzureBlobStorage>;
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
    users: createUserService({ sql, secrets }),
    documents: createDocumentService({ sql }),
    files: createAzureBlobStorage(fileConfig()),
  };
  return identityRuntime;
}
