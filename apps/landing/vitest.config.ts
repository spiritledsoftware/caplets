import { getViteConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const astroViteConfig = getViteConfig({ root });

export default defineConfig(async (environment) =>
  mergeConfig(await astroViteConfig(environment), {
    test: {
      include: ["test/**/*.test.ts"],
    },
  }),
);
