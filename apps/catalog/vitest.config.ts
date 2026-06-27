import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL("./test/fixtures/cloudflare-workers.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
