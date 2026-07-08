import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

const dashboardApiTarget = process.env.CAPLETS_DASHBOARD_API_TARGET;

export default defineConfig({
  output: "static",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    ...(dashboardApiTarget
      ? {
          server: {
            proxy: {
              "/dashboard/api": {
                target: dashboardApiTarget,
                changeOrigin: false,
                secure: false,
                ws: true,
              },
            },
          },
        }
      : {}),
  },
});
