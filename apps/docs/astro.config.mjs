// @ts-check
import starlight from "@astrojs/starlight";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

const sentryProject = process.env.CAPLETS_DOCS_SENTRY_PROJECT;
const sentryRelease = process.env.PUBLIC_CAPLETS_RELEASE;
const sentryConfigured = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && sentryProject && sentryRelease,
);

export default defineConfig({
  site: "https://docs.caplets.dev",
  integrations: [
    starlight({
      title: "Caplets Docs",
      favicon: "/icon.png",
      logo: {
        src: "./src/assets/caplets-icon.png",
        alt: "Caplets",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/spiritledsoftware/caplets",
        },
      ],
      customCss: ["./src/styles/global.css"],
      components: {
        ThemeProvider: "./src/components/CapletsThemeProvider.astro",
        ThemeSelect: "./src/components/CapletsThemeSelect.astro",
      },
      editLink: {
        baseUrl: "https://github.com/spiritledsoftware/caplets/edit/main/apps/docs/",
      },
      sidebar: [
        {
          label: "Get Started",
          items: [
            { label: "Quick Start", link: "/" },
            { label: "Install", link: "/install/" },
            { label: "Configuration", link: "/configuration/" },
          ],
        },
        {
          label: "Use Caplets",
          items: [
            { label: "Code Mode", link: "/code-mode/" },
            { label: "Add capabilities", link: "/capabilities/" },
            { label: "Catalog", link: "/catalog/" },
            { label: "Dashboard", link: "/dashboard/" },
            { label: "Caplets Vault", link: "/vault/" },
            { label: "Agent integrations", link: "/agent-integrations/" },
            { label: "Remote attach", link: "/remote-attach/" },
            { label: "Troubleshooting", link: "/troubleshooting/" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration schema", link: "/reference/config/" },
            { label: "Code Mode API", link: "/reference/code-mode-api/" },
            { label: "Caplet files", link: "/reference/caplet-files/" },
            { label: "Catalog indexing privacy", link: "/privacy/indexing/" },
            {
              label: "GitHub releases",
              link: "https://github.com/spiritledsoftware/caplets/releases",
            },
          ],
        },
      ],
    }),
  ],
  vite: {
    build: {
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
