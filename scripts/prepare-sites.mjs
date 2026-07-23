import { copyFileSync, existsSync, mkdirSync } from "node:fs";

mkdirSync("dist/server/ssr", { recursive: true });
mkdirSync("dist/.openai", { recursive: true });

if (existsSync("dist/server/index.mjs") && !existsSync("dist/server/index.js")) {
  copyFileSync("dist/server/index.mjs", "dist/server/index.js");
}
if (
  existsSync("dist/server/ssr/index.mjs") &&
  !existsSync("dist/server/ssr/index.js")
) {
  copyFileSync("dist/server/ssr/index.mjs", "dist/server/ssr/index.js");
}
copyFileSync(".openai/hosting.json", "dist/.openai/hosting.json");
