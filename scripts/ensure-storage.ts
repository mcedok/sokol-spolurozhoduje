import { createAzureBlobStorage } from "../server/modules/files/azure-blob-storage";
import { fileConfig } from "../server/modules/files/file-config";

const storage = createAzureBlobStorage(fileConfig());
await storage.ensureContainers();

process.stdout.write("Storage containers are ready.\n");
