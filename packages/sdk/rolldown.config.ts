import { defineConfig } from "rolldown";

export default defineConfig([
  {
    input: {
      index: "src/index.ts",
      "project-binding": "src/project-binding/index.ts",
    },
    output: {
      dir: "./dist",
      format: "esm",
    },
    platform: "browser",
    tsconfig: true,
  },
  {
    input: {
      "project-binding/node": "src/project-binding/node.ts",
    },
    output: {
      dir: "./dist",
      format: "esm",
    },
    platform: "node",
    tsconfig: true,
  },
]);
