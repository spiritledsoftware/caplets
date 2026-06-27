// @ts-check
import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";

const cloudflareDevMiddleware = fileURLToPath(
  new URL("./src/cloudflare-dev-middleware.ts", import.meta.url),
);
const cloudflareDevWorkers = fileURLToPath(
  new URL("./src/cloudflare-workers-dev.ts", import.meta.url),
);
const isProductionBuild = process.env.NODE_ENV === "production";
const optimizeExclude = [
  "tailwind-variants",
  "unified",
  "remark-parse",
  "remark-rehype",
  "rehype-sanitize",
  "rehype-stringify",
];

export default defineConfig({
  site: "https://catalog.caplets.dev",
  output: "server",
  adapter: cloudflare(),
  devToolbar: {
    enabled: false,
  },
  vite: {
    build: {
      assetsInlineLimit: 0,
    },
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        "@astrojs/cloudflare/entrypoints/middleware.js": cloudflareDevMiddleware,
        ...(isProductionBuild ? {} : { "cloudflare:workers": cloudflareDevWorkers }),
      },
    },
    ssr: {
      optimizeDeps: {
        exclude: optimizeExclude,
      },
    },
    optimizeDeps: {
      exclude: optimizeExclude,
    },
  },
});
