import alchemy from "alchemy";
import { Astro } from "alchemy/cloudflare";
import { GitHubComment } from "alchemy/github";
import { CloudflareStateStore } from "alchemy/state";

const baseDomain = "caplets.dev";

const app = await alchemy("caplets", {
  stateStore: (scope) => new CloudflareStateStore(scope),
  password: process.env.ALCHEMY_PASSWORD!,
});

const landingPageDomain = app.stage === "prod" ? baseDomain : `${app.stage}.${baseDomain}`;
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

if (process.env.PULL_REQUEST) {
  await GitHubComment("preview-comment", {
    owner: "your-username",
    repository: "your-repo",
    issueNumber: Number(process.env.PULL_REQUEST),
    body: `## 🚀 Preview Deployed

Your changes have been deployed to a preview environment:

**🌐 Landing Page:** ${landingPage.url}

Built from commit ${process.env.GITHUB_SHA?.slice(0, 7)}

+---
<sub>🤖 This comment updates automatically with each push.</sub>`,
  });
}

await app.finalize();
