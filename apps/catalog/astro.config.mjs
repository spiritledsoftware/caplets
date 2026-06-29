// @ts-check
import cloudflare from "@astrojs/cloudflare";
import { sentryVitePlugin } from "@sentry/vite-plugin";
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
const sentryProject = process.env.CAPLETS_CATALOG_SENTRY_PROJECT;
const sentryRelease = process.env.PUBLIC_CAPLETS_RELEASE;
const sentryConfigured = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && sentryProject && sentryRelease,
);
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
      sourcemap: sentryConfigured ? "hidden" : false,
    },
    plugins: [
      tailwindcss(),
      ...(sentryConfigured
        ? [
            sentryVitePlugin({
              authToken: process.env.SENTRY_AUTH_TOKEN,
              org: process.env.SENTRY_ORG,
              project: sentryProject,
              release: { name: sentryRelease },
              sourcemaps: {
                filesToDeleteAfterUpload: ["./dist/**/*.map"],
              },
            }),
          ]
        : []),
    ],
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
