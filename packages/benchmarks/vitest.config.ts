import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@caplets/core": resolve(import.meta.dirname, "../core/src/index.ts"),
    },
  },
});
