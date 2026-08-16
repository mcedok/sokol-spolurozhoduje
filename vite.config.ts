import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  resolve: process.env.NEXT_PUBLIC_DATA_BACKEND === "browser"
    ? {
      alias: {
        "@node-rs/argon2": fileURLToPath(
          new URL("./infra/browser-build/argon2-stub.js", import.meta.url),
        ),
      },
    }
    : undefined,
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
