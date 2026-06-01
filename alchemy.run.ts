import alchemy from "alchemy";
import { Astro, D1Database, R2Bucket, Vite, Worker } from "alchemy/cloudflare";
import { GitHubComment } from "alchemy/github";
import { CloudflareStateStore } from "alchemy/state";

import { buildAlchemyDomains } from "./infra/alchemy-domains.ts";

const app = await alchemy("caplets", {
  stateStore: (scope) => new CloudflareStateStore(scope),
  password: process.env.ALCHEMY_PASSWORD!,
});

const {
  appDomain,
  cloudApiDomains,
  cloudApiUrl,
  cloudUiEnv,
  landingPageDomain,
  landingPageUrl,
  appUrl,
} = buildAlchemyDomains(app.stage, { local: app.local });
export const landingPage = await Astro("landing-page", {
  cwd: "apps/landing",
  dev: {
    command: "pnpm run dev" + (process.env.SSH_CONNECTION ? " --host 0.0.0.0" : ""),
  },
  domains: [landingPageDomain, `www.${landingPageDomain}`],
});

export const cloudState = await D1Database("cloud-state", {
  name: `caplets-${app.stage}-cloud-state`,
});

export const cloudArtifacts = await R2Bucket("cloud-artifacts", {
  name: `caplets-${app.stage}-cloud-artifacts`,
});

export const cloudApi = await Worker("cloud-api", {
  cwd: "apps/cloud",
  entrypoint: "src/index.ts",
  dev: {
    port: 8787,
  },
  bindings: {
    CLOUD_STATE: cloudState,
    CLOUD_ARTIFACTS: cloudArtifacts,
  },
  domains: cloudApiDomains,
});

export const cloudUi = await Vite("cloud-ui", {
  cwd: "apps/cloud-ui",
  build: {
    env: cloudUiEnv,
  },
  dev: {
    command: "pnpm run dev" + (process.env.SSH_CONNECTION ? " --host 0.0.0.0" : ""),
    env: cloudUiEnv,
  },
  domains: [appDomain],
});

console.log({
  "Landing Page URL": landingPageUrl,
  "Caplets Cloud UI URL": appUrl,
  "Caplets Cloud API URL": cloudApiUrl,
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

  await GitHubComment("preview-comment", {
    owner: repositoryOwner,
    repository: repositoryName,
    issueNumber: pullRequestNumber,
    body: `## 🚀 Preview Deployed

Your changes have been deployed to a preview environment:

**🌐 Landing Page:** ${landingPageUrl}
**☁️ Caplets Cloud UI:** https://${appDomain}
**🔌 Caplets Cloud API Domain:** ${cloudApiUrl}

Built from commit ${process.env.GITHUB_SHA?.slice(0, 7) ?? "unknown"}

---
<sub>🤖 This comment updates automatically with each push.</sub>`,
  });
}

await app.finalize();
