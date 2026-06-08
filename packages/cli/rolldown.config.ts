import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
  output: {
    dir: "./dist",
    format: "esm",
    banner: "#!/usr/bin/env node",
  },
  external: ["@caplets/core"],
  platform: "node",
  tsconfig: true,
});
