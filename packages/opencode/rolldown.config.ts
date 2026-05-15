import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
  output: {
    dir: "./dist",
    format: "esm",
  },
  platform: "node",
  external: [
    "@caplets/core/generated-tool-input-schema",
    "@caplets/core/native",
    "@opencode-ai/plugin",
  ],
});
