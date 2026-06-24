import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";

import { buildAlchemyDomains } from "./alchemy-domains.js";
import { buildNodeOptions } from "./alchemy-runner.js";

const shimPath = fileURLToPath(new URL("./alchemy-fetch-compat.ts", import.meta.url));

test("Alchemy runner injects fetch shim through NODE_OPTIONS for child processes", () => {
  expect(buildNodeOptions(undefined)).toBe(`--import=${shimPath}`);
});

test("Alchemy runner preserves existing NODE_OPTIONS after the fetch shim", () => {
  expect(buildNodeOptions("--trace-warnings")).toBe(`--import=${shimPath} --trace-warnings`);
});

test.each([
  {
    landingPageDomain: "caplets.dev",
    stage: "prod",
  },
  {
    landingPageDomain: "branch.preview.caplets.dev",
    stage: "branch",
  },
  {
    landingPageDomain: "dev.preview.caplets.dev",
    stage: "dev",
  },
])("derives matching domains for $stage", ({ landingPageDomain, stage }) => {
  expect(buildAlchemyDomains(stage)).toMatchObject({
    landingPageDomain,
    landingPageUrl: `https://${landingPageDomain}`,
  });
});
