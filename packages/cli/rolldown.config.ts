import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
  output: {
    dir: "./dist",
    format: "esm",
    banner: "#!/usr/bin/env node",
  },
  platform: "node",
  external: ["@caplets/core", "@modelcontextprotocol/sdk/server/stdio"],
});
