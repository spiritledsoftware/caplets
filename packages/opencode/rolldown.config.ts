import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
  output: {
    dir: "./dist",
    format: "esm",
  },
  platform: "node",
  external: ["@caplets/core/native", "@opencode-ai/plugin"],
});
