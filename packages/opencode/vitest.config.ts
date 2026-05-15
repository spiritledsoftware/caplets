import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@caplets/core/native": resolve(import.meta.dirname, "../core/src/native.ts"),
    },
  },
});
