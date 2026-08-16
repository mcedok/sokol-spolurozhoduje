import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.SOKOL_PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./test/setup.js"] },
});
