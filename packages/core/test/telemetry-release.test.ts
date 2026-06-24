import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTelemetryReleaseEnv } from "../../../scripts/check-telemetry-release-env";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("telemetry release environment", () => {
  it("requires PostHog and Sentry intake identifiers", () => {
    expect(checkTelemetryReleaseEnv({})).toEqual([
      "CAPLETS_POSTHOG_TOKEN is required for telemetry-enabled releases.",
      "CAPLETS_SENTRY_DSN is required for telemetry-enabled releases.",
    ]);

    expect(
      checkTelemetryReleaseEnv({
        CAPLETS_POSTHOG_TOKEN: "phc_test_project_token",
        CAPLETS_SENTRY_DSN: "https://public@example.ingest.sentry.io/123",
      }),
    ).toEqual([]);
  });

  it("rejects placeholders and malformed DSNs", () => {
    expect(
      checkTelemetryReleaseEnv({
        CAPLETS_POSTHOG_TOKEN: "TODO",
        CAPLETS_SENTRY_DSN: "not-a-dsn",
      }),
    ).toEqual([
      "CAPLETS_POSTHOG_TOKEN must be a valid PostHog project token; placeholders are not allowed.",
      "CAPLETS_SENTRY_DSN must be a valid Sentry DSN; placeholders are not allowed.",
    ]);
  });

  it("wires telemetry secrets into the release workflow", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).toContain("publish: pnpm telemetry:prepare-release-env && pnpm release");
    expect(workflow).toContain("CAPLETS_POSTHOG_TOKEN: ${{ secrets.CAPLETS_POSTHOG_TOKEN }}");
    expect(workflow).toContain("CAPLETS_SENTRY_DSN: ${{ secrets.CAPLETS_SENTRY_DSN }}");
  });
});
