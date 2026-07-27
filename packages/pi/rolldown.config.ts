import { defineConfig } from "rolldown";
import { runtimeSentryPlugins, sentryConfigured } from "../../scripts/runtime-sentry-rolldown";

export default defineConfig({
  input: "src/index.ts",
  output: {
    dir: "./dist",
    format: "esm",
    sourcemap: sentryConfigured(),
  },
  plugins: runtimeSentryPlugins("pi"),
  platform: "node",
  tsconfig: true,
  external: [
    "@caplets/core/generated-tool-input-schema",
    "@caplets/core/native",
    "@earendil-works/pi-coding-agent",
    "jsonc-parser",
  ],
});
