// @ts-check
import { defineConfig } from "astro/config";

import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  devToolbar: {
    enabled: false,
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      allowedHosts: ["chilly-comics-hear.loca.lt"],
      proxy: {
        "/__impeccable": {
          target: "http://127.0.0.1:8400",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/__impeccable/, ""),
        },
      },
    },
  },
});
