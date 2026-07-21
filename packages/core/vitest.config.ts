import { defineConfig } from "vitest/config";
import { sdkSourceAliases } from "../../vitest.sdk-source";

export default defineConfig({
  resolve: {
    alias: sdkSourceAliases("node"),
  },
  test: {
    setupFiles: ["./test/setup-env.ts"],
  },
});
