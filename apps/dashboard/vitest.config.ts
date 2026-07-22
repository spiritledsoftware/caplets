import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sdkSourceAliases } from "../../vitest.sdk-source";

export default defineConfig({
  resolve: {
    alias: [
      ...sdkSourceAliases("browser"),
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
    ],
  },
  test: {
    execArgv: ["--no-experimental-webstorage"],
  },
});
