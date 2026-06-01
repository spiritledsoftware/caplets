import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    "cloud-runtime": "src/cloud-runtime.ts",
    "generated-tool-input-schema": "src/generated-tool-input-schema.ts",
    native: "src/native.ts",
  },
  output: {
    dir: "./dist",
    format: "esm",
  },
  platform: "node",
});
