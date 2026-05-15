import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    native: "src/native.ts",
  },
  output: {
    dir: "./dist",
    format: "esm",
  },
  platform: "node",
});
