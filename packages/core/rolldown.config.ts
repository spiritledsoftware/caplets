import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    "generated-tool-input-schema": "src/generated-tool-input-schema.mjs",
    native: "src/native.ts",
  },
  output: {
    dir: "./dist",
    format: "esm",
  },
  platform: "node",
});
