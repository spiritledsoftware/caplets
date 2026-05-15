import { defineConfig } from "rolldown";

export default defineConfig({
  input: "../../scripts/generate-config-schema.ts",
  output: {
    dir: "./dist-schema",
    format: "esm",
  },
  platform: "node",
});
