import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "root",
          include: ["infra/**/*.test.ts", "scripts/**/*.test.ts"],
        },
      },
      "apps/*",
      "packages/*",
      "tools/*",
    ],
  },
});
