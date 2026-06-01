import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildAlchemyDomains } from "./alchemy-domains.js";
import { buildNodeOptions } from "./alchemy-runner.js";

const shimPath = fileURLToPath(new URL("./alchemy-fetch-compat.ts", import.meta.url));
const alchemyRunPath = fileURLToPath(new URL("../alchemy.run.ts", import.meta.url));

test("Alchemy runner injects fetch shim through NODE_OPTIONS for child processes", () => {
  expect(buildNodeOptions(undefined)).toBe(`--import=${shimPath}`);
});

test("Alchemy runner preserves existing NODE_OPTIONS after the fetch shim", () => {
  expect(buildNodeOptions("--trace-warnings")).toBe(`--import=${shimPath} --trace-warnings`);
});

test("Alchemy runner keeps fetch compatibility shim for cloud deployments", () => {
  expect(buildNodeOptions()).toContain("alchemy-fetch-compat");
});

test("Cloud UI deployment injects matching Cloud API origin into Vite", () => {
  const source = readFileSync(alchemyRunPath, "utf8");

  expect(source).toContain('from "./infra/alchemy-domains.ts"');
  expect(source).toContain("buildAlchemyDomains(app.stage, { local: app.local })");
  expect(source).toMatch(/build:\s*{\s*env:\s*cloudUiEnv,\s*}/s);
  expect(source).toMatch(/dev:\s*{[^}]*env:\s*cloudUiEnv,/s);
});

test.each([
  {
    appDomain: "app.caplets.dev",
    cloudApiUrl: "https://cloud.caplets.dev",
    cloudApiDomains: ["cloud.caplets.dev"],
    cloudDomain: "cloud.caplets.dev",
    landingPageDomain: "caplets.dev",
    stage: "prod",
  },
  {
    appDomain: "app.branch.preview.caplets.dev",
    cloudApiUrl: "https://cloud.branch.preview.caplets.dev",
    cloudApiDomains: ["cloud.branch.preview.caplets.dev"],
    cloudDomain: "cloud.branch.preview.caplets.dev",
    landingPageDomain: "branch.preview.caplets.dev",
    stage: "branch",
  },
  {
    appDomain: "app.dev.preview.caplets.dev",
    cloudApiUrl: "https://cloud.dev.preview.caplets.dev",
    cloudApiDomains: ["cloud.dev.preview.caplets.dev"],
    cloudDomain: "cloud.dev.preview.caplets.dev",
    landingPageDomain: "dev.preview.caplets.dev",
    stage: "dev",
  },
])(
  "derives matching Cloud UI and API domains for $stage",
  ({ appDomain, cloudApiDomains, cloudApiUrl, cloudDomain, landingPageDomain, stage }) => {
    expect(buildAlchemyDomains(stage)).toMatchObject({
      appDomain,
      cloudApiDomains,
      cloudApiUrl,
      cloudDomain,
      cloudUiEnv: {
        VITE_CAPLETS_CLOUD_API_URL: cloudApiUrl,
        VITE_CAPLETS_WORKSPACE_SLUG: "personal",
      },
      landingPageDomain,
      landingPageUrl: `https://${landingPageDomain}`,
    });
  },
);

test("derives local Cloud API origin for alchemy dev", () => {
  expect(buildAlchemyDomains("ianpascoe", { local: true })).toMatchObject({
    appDomain: "app.ianpascoe.preview.caplets.dev",
    cloudApiDomains: [],
    cloudApiUrl: "http://localhost:8787",
    cloudDomain: "cloud.ianpascoe.preview.caplets.dev",
    cloudUiEnv: {
      VITE_CAPLETS_CLOUD_API_URL: "http://localhost:8787",
      VITE_CAPLETS_WORKSPACE_SLUG: "personal",
    },
  });
});
