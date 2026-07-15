import { defineConfig } from "rolldown";
import { runtimeSentryPlugins, sentryConfigured } from "../../scripts/runtime-sentry-rolldown";

export default defineConfig([
  {
    input: {
      index: "src/index.ts",
      "caplet-source/filesystem": "src/caplet-source/filesystem.ts",
      "config-runtime": "src/config-runtime.ts",
      "control-plane/model": "src/control-plane/model/index.ts",
      "control-plane/caplets": "src/control-plane/caplets/index.ts",
      "control-plane/migration/legacy-model": "src/control-plane/migration/legacy-model.ts",
      "control-plane/storage": "src/control-plane/storage.ts",
      "control-plane/schema/model-codec": "src/control-plane/schema/model-codec.ts",
      "control-plane/schema/sqlite": "src/control-plane/schema/sqlite.ts",
      "control-plane/schema/postgres": "src/control-plane/schema/postgres.ts",
      "control-plane/dialect/migrations": "src/control-plane/dialect/migrations.ts",
      "control-plane/dialect/sqlite": "src/control-plane/dialect/sqlite.ts",
      "control-plane/dialect/postgres": "src/control-plane/dialect/postgres.ts",
      "control-plane/security": "src/control-plane/security/index.ts",
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
      "jsonc-parser",
      "quickjs-emscripten",
      "typescript",
      "better-sqlite3",
      "pg",
      /^drizzle-orm(?:\/.*)?$/u,
      /^@aws-sdk\/client-s3(?:\/.*)?$/u,
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
