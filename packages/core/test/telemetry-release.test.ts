import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTelemetryReleaseEnv } from "../../../scripts/check-telemetry-release-env";
import { checkSentrySourceMapEnv } from "../../../scripts/check-sentry-source-maps";
import { checkWebObservabilityEnv } from "../../../scripts/check-web-observability-env";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("telemetry release environment", () => {
  it("requires PostHog and Sentry intake identifiers", () => {
    expect(checkTelemetryReleaseEnv({})).toEqual([
      "CAPLETS_POSTHOG_TOKEN is required for telemetry-enabled releases.",
      "CAPLETS_RUNTIME_SENTRY_DSN is required for telemetry-enabled releases.",
      "CAPLETS_SENTRY_AUTH_TOKEN is required for telemetry-enabled releases.",
      "CAPLETS_SENTRY_ORG is required for telemetry-enabled releases.",
      "CAPLETS_RUNTIME_SENTRY_PROJECT is required for telemetry-enabled releases.",
      "CAPLETS_SENTRY_RELEASE is required for telemetry-enabled releases.",
      "CAPLETS_SENTRY_ENVIRONMENT is required for telemetry-enabled releases.",
    ]);

    expect(
      checkTelemetryReleaseEnv({
        CAPLETS_POSTHOG_TOKEN: "phc_test_project_token",
        CAPLETS_RUNTIME_SENTRY_DSN: "https://public@example.ingest.sentry.io/123",
        CAPLETS_SENTRY_AUTH_TOKEN: "sntrys_token",
        CAPLETS_SENTRY_ORG: "spirit-led-software",
        CAPLETS_RUNTIME_SENTRY_PROJECT: "caplets-runtime",
        CAPLETS_SENTRY_RELEASE: "caplets@0.30.0",
        CAPLETS_SENTRY_ENVIRONMENT: "production",
      }),
    ).toEqual([]);
  });

  it("rejects placeholders and malformed DSNs", () => {
    expect(
      checkTelemetryReleaseEnv({
        CAPLETS_POSTHOG_TOKEN: "TODO",
        CAPLETS_RUNTIME_SENTRY_DSN: "not-a-dsn",
        CAPLETS_SENTRY_AUTH_TOKEN: "TODO",
        CAPLETS_SENTRY_ORG: "not a slug",
        CAPLETS_RUNTIME_SENTRY_PROJECT: "placeholder",
        CAPLETS_SENTRY_RELEASE: "TODO",
        CAPLETS_SENTRY_ENVIRONMENT: "not a slug",
      }),
    ).toEqual([
      "CAPLETS_POSTHOG_TOKEN must be a valid PostHog project token; placeholders are not allowed.",
      "CAPLETS_RUNTIME_SENTRY_DSN must be a valid Sentry DSN; placeholders are not allowed.",
      "CAPLETS_SENTRY_AUTH_TOKEN must be a valid Sentry auth token; placeholders are not allowed.",
      "CAPLETS_SENTRY_ORG must be a valid Sentry org slug; placeholders are not allowed.",
      "CAPLETS_RUNTIME_SENTRY_PROJECT must be a valid runtime Sentry project slug; placeholders are not allowed.",
      "CAPLETS_SENTRY_RELEASE must be a valid runtime Sentry release; placeholders are not allowed.",
      "CAPLETS_SENTRY_ENVIRONMENT must be a valid runtime Sentry environment; placeholders are not allowed.",
    ]);
  });

  it("requires web observability and source-map upload env", () => {
    expect(checkWebObservabilityEnv({})).toContain(
      "PUBLIC_CAPLETS_POSTHOG_TOKEN is required for observability-enabled site deploys.",
    );
    expect(checkSentrySourceMapEnv({})).toContain(
      "SENTRY_AUTH_TOKEN is required before uploading Sentry source maps.",
    );

    const env = {
      PUBLIC_CAPLETS_POSTHOG_TOKEN: "phc_public",
      PUBLIC_CAPLETS_POSTHOG_HOST: "https://us.i.posthog.com",
      PUBLIC_CAPLETS_LANDING_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      PUBLIC_CAPLETS_DOCS_SENTRY_DSN: "https://public@example.ingest.sentry.io/2",
      PUBLIC_CAPLETS_CATALOG_SENTRY_DSN: "https://public@example.ingest.sentry.io/3",
      SENTRY_AUTH_TOKEN: "sntrys_token",
      SENTRY_ORG: "spirit-led-software",
      CAPLETS_LANDING_SENTRY_PROJECT: "caplets-landing",
      CAPLETS_DOCS_SENTRY_PROJECT: "caplets-docs",
      CAPLETS_CATALOG_SENTRY_PROJECT: "caplets-catalog",
      PUBLIC_CAPLETS_RELEASE: "sites@abc123",
      PUBLIC_CAPLETS_ENVIRONMENT: "production",
    };
    expect(checkWebObservabilityEnv(env)).toEqual([]);
    expect(checkSentrySourceMapEnv(env)).toEqual([]);
  });

  it("rejects insecure web observability endpoints and release-gate placeholders", () => {
    expect(
      checkWebObservabilityEnv({
        PUBLIC_CAPLETS_POSTHOG_TOKEN: "change-me",
        PUBLIC_CAPLETS_POSTHOG_HOST: "http://us.i.posthog.com",
        PUBLIC_CAPLETS_LANDING_SENTRY_DSN: "http://public@example.ingest.sentry.io/1",
        PUBLIC_CAPLETS_DOCS_SENTRY_DSN: "https://public@example.ingest.sentry.io/2",
        PUBLIC_CAPLETS_CATALOG_SENTRY_DSN: "https://public@example.ingest.sentry.io/3",
        SENTRY_AUTH_TOKEN: "todo before release",
        SENTRY_ORG: "spirit-led-software",
        CAPLETS_LANDING_SENTRY_PROJECT: "caplets-landing",
        CAPLETS_DOCS_SENTRY_PROJECT: "caplets-docs",
        CAPLETS_CATALOG_SENTRY_PROJECT: "caplets-catalog",
        PUBLIC_CAPLETS_RELEASE: "sites@abc123",
        PUBLIC_CAPLETS_ENVIRONMENT: "production",
      }),
    ).toEqual([
      "PUBLIC_CAPLETS_POSTHOG_TOKEN must be a valid public PostHog project token; placeholders are not allowed.",
      "PUBLIC_CAPLETS_POSTHOG_HOST must be a valid public PostHog host; placeholders are not allowed.",
      "PUBLIC_CAPLETS_LANDING_SENTRY_DSN must be a valid landing Sentry DSN; placeholders are not allowed.",
      "SENTRY_AUTH_TOKEN must be a valid Sentry source-map auth token; placeholders are not allowed.",
    ]);
  });

  it("wires telemetry secrets into the release workflow", () => {
    const packageJson = read("package.json");
    const workflow = read(".github/workflows/release.yml");

    expect(packageJson).toContain(
      '"release:publish": "pnpm telemetry:prepare-release-env && pnpm release"',
    );
    expect(workflow).toContain("publish: pnpm release:publish");
    expect(workflow).toContain("CAPLETS_POSTHOG_TOKEN: ${{ secrets.CAPLETS_POSTHOG_TOKEN }}");
    expect(workflow).toContain(
      "CAPLETS_RUNTIME_SENTRY_DSN: ${{ secrets.CAPLETS_RUNTIME_SENTRY_DSN }}",
    );
    expect(workflow).toContain(
      "CAPLETS_SENTRY_AUTH_TOKEN: ${{ secrets.CAPLETS_SENTRY_AUTH_TOKEN }}",
    );
    expect(workflow).toContain(
      "CAPLETS_RUNTIME_SENTRY_PROJECT: ${{ secrets.CAPLETS_RUNTIME_SENTRY_PROJECT }}",
    );
  });

  it("wires runtime telemetry and current workspace packages into Docker image builds", () => {
    const dockerfile = read("Dockerfile");
    const compose = read("docker-compose.yml");
    const workflow = read(".github/workflows/release.yml");
    const packageJson = JSON.parse(read("package.json")) as { packageManager: string };
    const catalogPackageJson = JSON.parse(read("apps/catalog/package.json")) as {
      packageManager: string;
    };
    const docsPackageJson = JSON.parse(read("apps/docs/package.json")) as {
      packageManager: string;
    };

    expect(dockerfile).toContain(`ARG PNPM_VERSION=${packageJson.packageManager.slice(5)}`);
    expect(catalogPackageJson.packageManager).toBe(packageJson.packageManager);
    expect(docsPackageJson.packageManager).toBe(packageJson.packageManager);
    for (const manifest of [
      "apps/catalog/package.json",
      "apps/docs/package.json",
      "apps/landing/package.json",
      "packages/core/package.json",
      "packages/cli/package.json",
      "packages/opencode/package.json",
      "packages/pi/package.json",
      "packages/benchmarks/package.json",
      "packages/web-observability/package.json",
    ]) {
      expect(dockerfile).toContain(`COPY ${manifest} ${manifest}`);
    }

    expect(dockerfile).toContain("ARG CAPLETS_POSTHOG_TOKEN");
    expect(dockerfile).toContain("ARG CAPLETS_RUNTIME_SENTRY_DSN");
    expect(dockerfile).toContain("ARG CAPLETS_SENTRY_RELEASE");
    expect(dockerfile).toContain(
      "CAPLETS_REMOTE_SERVER_STATE_DIR=/data/state/caplets/remote-server",
    );
    expect(dockerfile).toContain("pnpm --filter caplets deploy --prod --legacy /deploy");
    expect(dockerfile).toContain("COPY --from=build --chown=node:root /deploy ./");
    expect(dockerfile).toContain("http://127.0.0.1:5387/v1/healthz");
    expect(dockerfile).toContain("node dist/index.js init --global");
    expect(dockerfile).toContain("node dist/index.js serve --transport http --host 0.0.0.0");
    expect(compose).toContain("CAPLETS_REMOTE_SERVER_STATE_DIR: /data/state/caplets/remote-server");
    expect(compose).toContain("http://127.0.0.1:5387/v1/healthz");
    expect(compose).not.toContain("CAPLETS_SERVER_USER");
    expect(compose).not.toContain("CAPLETS_SERVER_PASSWORD");
    expect(workflow).toContain("CAPLETS_POSTHOG_TOKEN=${{ secrets.CAPLETS_POSTHOG_TOKEN }}");
    expect(workflow).toContain(
      "CAPLETS_RUNTIME_SENTRY_DSN=${{ secrets.CAPLETS_RUNTIME_SENTRY_DSN }}",
    );
    expect(workflow).toContain("CAPLETS_SENTRY_RELEASE=caplets-runtime@${{ github.sha }}");
    expect(workflow).toContain("CAPLETS_SENTRY_ENVIRONMENT=production");
  });

  it("wires web observability env into deploy and preview workflows", () => {
    const deploy = read(".github/workflows/deploy.yml");
    const preview = read(".github/workflows/pr-preview-deploy.yml");
    for (const workflow of [deploy, preview]) {
      expect(workflow).toContain("pnpm telemetry:check-web-env");
      expect(workflow).toContain("pnpm telemetry:check-source-maps");
      expect(workflow).toContain(
        "PUBLIC_CAPLETS_POSTHOG_TOKEN: ${{ secrets.CAPLETS_POSTHOG_TOKEN }}",
      );
      expect(workflow).toContain(
        "PUBLIC_CAPLETS_POSTHOG_HOST: ${{ secrets.CAPLETS_POSTHOG_HOST }}",
      );
      expect(workflow).toContain(
        "PUBLIC_CAPLETS_LANDING_SENTRY_DSN: ${{ secrets.CAPLETS_LANDING_SENTRY_DSN }}",
      );
      expect(workflow).toContain(
        "PUBLIC_CAPLETS_DOCS_SENTRY_DSN: ${{ secrets.CAPLETS_DOCS_SENTRY_DSN }}",
      );
      expect(workflow).toContain(
        "PUBLIC_CAPLETS_CATALOG_SENTRY_DSN: ${{ secrets.CAPLETS_CATALOG_SENTRY_DSN }}",
      );
      expect(workflow).toContain(
        "CAPLETS_CATALOG_SENTRY_DSN: ${{ secrets.CAPLETS_CATALOG_SENTRY_DSN }}",
      );
      expect(workflow).toContain("SENTRY_AUTH_TOKEN: ${{ secrets.CAPLETS_SENTRY_AUTH_TOKEN }}");
      expect(workflow).toContain("SENTRY_ORG: ${{ secrets.CAPLETS_SENTRY_ORG }}");
      expect(workflow).toContain(
        "CAPLETS_CATALOG_SENTRY_PROJECT: ${{ secrets.CAPLETS_CATALOG_SENTRY_PROJECT }}",
      );
      expect(workflow).not.toContain("secrets.SENTRY_PROJECT_");
      expect(workflow).not.toContain("secrets.PUBLIC_CAPLETS_");
      expect(workflow).not.toContain("secrets.SENTRY_AUTH_TOKEN");
      expect(workflow).not.toContain("secrets.SENTRY_ORG");
    }
  });
});
