import { defineConfig } from "rolldown";
import { runtimeSentryPlugins, sentryConfigured } from "../../scripts/runtime-sentry-rolldown";

export default defineConfig({
  input: "src/index.ts",
  output: {
    dir: "./dist",
    format: "esm",
    sourcemap: sentryConfigured(),
  },
  plugins: runtimeSentryPlugins("opencode"),
  platform: "node",
  tsconfig: true,
  external: ["@opencode-ai/plugin"],
});
