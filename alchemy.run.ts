import alchemy from "alchemy";
import { Astro, D1Database } from "alchemy/cloudflare";
import { GitHubComment } from "alchemy/github";
import { CloudflareStateStore } from "alchemy/state";

import { buildAlchemyDomains } from "./infra/alchemy-domains.ts";

const app = await alchemy("caplets", {
  stateStore: (scope) => new CloudflareStateStore(scope),
  password: process.env.ALCHEMY_PASSWORD!,
});

const {
  catalogPageDomain,
  catalogPageUrl,
  docsPageDomain,
  docsPageUrl,
  landingPageDomain,
  landingPageUrl,
} = buildAlchemyDomains(app.stage, { local: app.local });
const hostSuffix = process.env.SSH_CONNECTION ? " --host 0.0.0.0" : "";
export const landingPage = await Astro("landing-page", {
  cwd: "apps/landing",
  dev: {
    command: "pnpm run dev --port 4321" + hostSuffix,
  },
  domains: [landingPageDomain, `www.${landingPageDomain}`],
});
export const docsPage = await Astro("docs-page", {
  cwd: "apps/docs",
  dev: {
    command: "pnpm run dev --port 4322" + hostSuffix,
  },
  domains: [docsPageDomain],
});
export const catalogDatabase = await D1Database("catalog-database", {
  name: `caplets-${app.stage}-catalog`,
  migrationsDir: "apps/catalog/migrations",
  adopt: true,
  delete: false,
});
export const catalogPage = await Astro("catalog-page", {
  cwd: "apps/catalog",
  dev: {
    command: "pnpm run dev --port 4323" + hostSuffix,
  },
  bindings: {
    CATALOG_DB: catalogDatabase,
  },
  domains: [catalogPageDomain],
});

console.log({
  "Landing Page URL": landingPageUrl,
  "Docs Page URL": docsPageUrl,
  "Catalog Page URL": catalogPageUrl,
});

const [repositoryOwnerFromSlug, repositoryNameFromSlug] =
  process.env.GITHUB_REPOSITORY?.split("/") ?? [];
const repositoryOwner = process.env.GITHUB_REPOSITORY_OWNER ?? repositoryOwnerFromSlug;
const repositoryName = process.env.GITHUB_REPOSITORY_NAME ?? repositoryNameFromSlug;
const pullRequestNumber = process.env.PULL_REQUEST
  ? Number.parseInt(process.env.PULL_REQUEST, 10)
  : undefined;
if (pullRequestNumber) {
  if (!repositoryOwner || !repositoryName) {
    throw new Error("Missing GitHub repository metadata for preview comment.");
  }

  const shortSha = process.env.GITHUB_SHA?.slice(0, 7) ?? "unknown";
  await GitHubComment("preview-comment", {
    owner: repositoryOwner,
    repository: repositoryName,
    issueNumber: pullRequestNumber,
    body: `## Preview Deployed

Landing: ${landingPageUrl}
Docs: ${docsPageUrl}
Catalog: ${catalogPageUrl}

Built from commit ${shortSha}`,
  });
}

await app.finalize();
