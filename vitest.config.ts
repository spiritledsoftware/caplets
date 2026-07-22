import { defineConfig } from "vitest/config";
import { sdkSourceAliases } from "./vitest.sdk-source";

export const rootTestProject = {
  resolve: {
    alias: sdkSourceAliases("node"),
  },
  test: {
    name: "root",
    include: ["infra/**/*.test.ts", "scripts/**/*.test.ts"],
  },
};

export default defineConfig({
  test: {
    projects: [rootTestProject, "apps/*", "packages/*", "tools/*"],
  },
});
