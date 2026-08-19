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
import { createUploadService } from "./modules/files/upload-service";
import { createConversionService } from "./modules/conversion/conversion-service";
import { createFileDownloadService } from "./modules/files/file-download-service";
import { createVersioningService } from "./modules/versioning/versioning-service";
import { createExportService } from "./modules/exports/export-service";
import { createXlsxExportService } from "./modules/xlsx/xlsx-export-service";

export interface IdentityRuntime {
  sql: Sql;
  secrets: SecretService;
  auth: ReturnType<typeof createAuthService>;
  users: ReturnType<typeof createUserService>;
  documents: ReturnType<typeof createDocumentService>;
  files: ReturnType<typeof createAzureBlobStorage>;
  uploads: ReturnType<typeof createUploadService>;
  conversions: ReturnType<typeof createConversionService>;
  downloads: ReturnType<typeof createFileDownloadService>;
  versioning: ReturnType<typeof createVersioningService>;
  exports: ReturnType<typeof createExportService>;
  xlsxExports: ReturnType<typeof createXlsxExportService>;
}

let identityRuntime: IdentityRuntime | undefined;

export function getIdentityRuntime(): IdentityRuntime {
  if (identityRuntime) return identityRuntime;
  const sql = createDatabase(databaseConfig().databaseUrl);
  const secrets = createSecretServiceFromEnvironment();
  const config = fileConfig();
  const files = createAzureBlobStorage(config);
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
    files,
    uploads: createUploadService({ sql, storage: files, config }),
    conversions: createConversionService({ sql }),
    downloads: createFileDownloadService({
      sql,
      storage: files,
      ttlSeconds: config.readUrlTtlSeconds,
    }),
    versioning: createVersioningService({ sql }),
    exports: createExportService({ sql }),
    xlsxExports: createXlsxExportService({ sql }),
  };
  return identityRuntime;
}
