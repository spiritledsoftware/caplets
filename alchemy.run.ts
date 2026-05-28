import alchemy from "alchemy";
import { Astro } from "alchemy/cloudflare";
import { GitHubComment } from "alchemy/github";
import { CloudflareStateStore } from "alchemy/state";

const baseDomain = "caplets.dev";

const app = await alchemy("caplets", {
  stateStore: (scope) => new CloudflareStateStore(scope),
  password: process.env.ALCHEMY_PASSWORD!,
});

const landingPageDomain = app.stage === "prod" ? baseDomain : `${app.stage}.preview.${baseDomain}`;
const [repositoryOwnerFromSlug, repositoryNameFromSlug] =
  process.env.GITHUB_REPOSITORY?.split("/") ?? [];
const repositoryOwner = process.env.GITHUB_REPOSITORY_OWNER ?? repositoryOwnerFromSlug;
const repositoryName = process.env.GITHUB_REPOSITORY_NAME ?? repositoryNameFromSlug;
const pullRequestNumber = process.env.PULL_REQUEST
  ? Number.parseInt(process.env.PULL_REQUEST, 10)
  : undefined;

export const landingPage = await Astro("landing-page", {
  assets: "apps/landing/dist",
  cwd: "apps/landing",
  dev: {
    command: "pnpm run dev" + (process.env.SSH_CONNECTION ? " --host 0.0.0.0" : ""),
  },
  domains: [landingPageDomain],
});

console.log({
  "Landing Page URL": landingPage.url,
});

if (pullRequestNumber) {
  if (!repositoryOwner || !repositoryName) {
    throw new Error("Missing GitHub repository metadata for preview comment.");
  }

  await GitHubComment("preview-comment", {
    owner: repositoryOwner,
    repository: repositoryName,
    issueNumber: pullRequestNumber,
    body: `## 🚀 Preview Deployed

Your changes have been deployed to a preview environment:

**🌐 Landing Page:** ${landingPage.url}

Built from commit ${process.env.GITHUB_SHA?.slice(0, 7) ?? "unknown"}

---
<sub>🤖 This comment updates automatically with each push.</sub>`,
  });
}

await app.finalize();
