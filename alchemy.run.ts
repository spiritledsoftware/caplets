import alchemy from "alchemy";
import { Astro } from "alchemy/cloudflare";
import { GitHubComment } from "alchemy/github";
import { CloudflareStateStore } from "alchemy/state";

import { buildAlchemyDomains } from "./infra/alchemy-domains.ts";

const app = await alchemy("caplets", {
  stateStore: (scope) => new CloudflareStateStore(scope),
  password: process.env.ALCHEMY_PASSWORD!,
});

const { docsPageDomain, docsPageUrl, landingPageDomain, landingPageUrl } = buildAlchemyDomains(
  app.stage,
  { local: app.local },
);
export const landingPage = await Astro("landing-page", {
  cwd: "apps/landing",
  dev: {
    command: "pnpm run dev" + (process.env.SSH_CONNECTION ? " --host 0.0.0.0" : ""),
  },
  domains: [landingPageDomain, `www.${landingPageDomain}`],
});
export const docsPage = await Astro("docs-page", {
  cwd: "apps/docs",
  dev: {
    command: "pnpm run dev -- --port 4322" + (process.env.SSH_CONNECTION ? " --host 0.0.0.0" : ""),
  },
  domains: [docsPageDomain],
});

console.log({
  "Landing Page URL": landingPageUrl,
  "Docs Page URL": docsPageUrl,
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

Built from commit ${shortSha}`,
  });
}

await app.finalize();
