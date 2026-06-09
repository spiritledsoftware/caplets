import { defineConfig } from "rolldown";

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
    },
    external: ["quickjs-emscripten", "typescript"],
    platform: "node",
  },
  {
    input: {
      "caplet-source": "src/caplet-source/index.ts",
      "code-mode": "src/code-mode/index.ts",
      "observed-output-shapes/pure": "src/observed-output-shapes/pure.ts",
      "runtime-plan": "src/runtime-plan/index.ts",
    },
    output: {
      dir: "./dist",
      format: "esm",
    },
    platform: "browser",
  },
]);
