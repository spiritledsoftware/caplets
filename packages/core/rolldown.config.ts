import { defineConfig } from "rolldown";
import { runtimeSentryPlugins, sentryConfigured } from "../../scripts/runtime-sentry-rolldown";

export default defineConfig([
  {
    input: {
      index: "src/index.ts",
      "caplet-source/filesystem": "src/caplet-source/filesystem.ts",
      "config-runtime": "src/config-runtime.ts",
      "generated-tool-input-schema": "src/generated-tool-input-schema.ts",
      native: "src/native.ts",
      "observed-output-shapes": "src/observed-output-shapes/index.ts",
    },
    output: {
      dir: "./dist",
      format: "esm",
      sourcemap: sentryConfigured(),
    },
    plugins: runtimeSentryPlugins("core"),
    external: [
      "better-sqlite3",
      "jsonc-parser",
      "quickjs-emscripten",
      "typescript",
      "typescript-compiler-api",
    ],
    platform: "node",
  },
  {
    input: {
      "caplet-source": "src/caplet-source/index.ts",
      "code-mode": "src/code-mode/index.ts",
      catalog: "src/catalog/index.ts",
      "observed-output-shapes/pure": "src/observed-output-shapes/pure.ts",
      "project-binding": "src/project-binding/index.ts",
      redaction: "src/redaction.ts",
      "runtime-plan": "src/runtime-plan/index.ts",
      "stable-json": "src/stable-json.ts",
    },
    output: {
      dir: "./dist",
      format: "esm",
      sourcemap: sentryConfigured(),
    },
    plugins: runtimeSentryPlugins("core"),
    platform: "browser",
  },
]);
