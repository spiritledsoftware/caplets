import { defineConfig } from "rolldown";
import { runtimeSentryPlugins, sentryConfigured } from "../../scripts/runtime-sentry-rolldown";

export default defineConfig({
  input: "src/index.ts",
  output: {
    dir: "./dist",
    format: "esm",
    banner: "#!/usr/bin/env node",
    sourcemap: sentryConfigured(),
  },
  plugins: runtimeSentryPlugins("cli"),
  external: ["@caplets/core"],
  platform: "node",
  tsconfig: true,
});
