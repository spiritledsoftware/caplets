// @ts-check
import { defineConfig } from "astro/config";

import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

const sentryProject = process.env.CAPLETS_LANDING_SENTRY_PROJECT;
const sentryRelease = process.env.PUBLIC_CAPLETS_RELEASE;
const sentryConfigured = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && sentryProject && sentryRelease,
);

// https://astro.build/config
export default defineConfig({
  devToolbar: {
    enabled: false,
  },
  vite: {
    build: {
      // The landing aperture scene is idle-loaded as a separate Three.js chunk.
      chunkSizeWarningLimit: 650,
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
  },
});
