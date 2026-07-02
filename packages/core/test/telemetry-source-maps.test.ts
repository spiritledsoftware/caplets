import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSentrySourceMapEnv } from "../../../scripts/check-sentry-source-maps";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("Sentry source-map readiness", () => {
  it("fails before source-map upload env is configured", () => {
    expect(checkSentrySourceMapEnv({ PUBLIC_CAPLETS_RELEASE: "sites@abc123" })).toEqual([
      "SENTRY_AUTH_TOKEN is required before uploading Sentry source maps.",
      "SENTRY_ORG is required before uploading Sentry source maps.",
      "CAPLETS_LANDING_SENTRY_PROJECT is required before uploading Sentry source maps.",
      "CAPLETS_DOCS_SENTRY_PROJECT is required before uploading Sentry source maps.",
      "CAPLETS_CATALOG_SENTRY_PROJECT is required before uploading Sentry source maps.",
      "PUBLIC_CAPLETS_ENVIRONMENT is required before uploading Sentry source maps.",
    ]);
  });

  it("wires runtime source-map generation and upload into release", () => {
    const coreConfig = read("packages/core/rolldown.config.ts");
    const cliConfig = read("packages/cli/rolldown.config.ts");
    const opencodeConfig = read("packages/opencode/rolldown.config.ts");
    const piConfig = read("packages/pi/rolldown.config.ts");
    const packageJson = read("package.json");

    for (const config of [coreConfig, cliConfig, opencodeConfig, piConfig]) {
      expect(config).toContain("runtimeSentryPlugins");
      expect(config).toContain("sentryConfigured");
      expect(config).toMatch(/sourcemap:\s*sentryConfigured\(\)/u);
    }
    expect(coreConfig).toContain('runtimeSentryPlugins("core")');
    expect(coreConfig).not.toContain('disable: "disable-upload"');
    expect(cliConfig).toContain('runtimeSentryPlugins("cli")');
    expect(opencodeConfig).toContain('runtimeSentryPlugins("opencode")');
    expect(piConfig).toContain('runtimeSentryPlugins("pi")');
    expect(packageJson).toContain('"release": "turbo build --force &&');
    expect(packageJson).toContain("changeset publish");
    expect(packageJson).not.toContain("telemetry:upload-runtime-source-maps");
    expect(packageJson).not.toContain("sentry-cli");
  });
});
