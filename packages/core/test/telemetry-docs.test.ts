import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("telemetry product docs", () => {
  it("names every provider launch-gate field", () => {
    const text = read("docs/product/telemetry-provider-readiness.md");

    for (const expected of [
      "PostHog project",
      "PostHog intake identifier",
      "Sentry project",
      "Sentry intake identifier",
      "Owner",
      "Review date",
      "Retention",
      "Ingestion monitoring",
      "Revocation",
      "Release Gate",
      "Source maps",
      "CAPLETS_CATALOG_SENTRY_PROJECT",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("TODO");
  });

  it("maps decision questions to allowlisted event families", () => {
    const text = read("docs/product/telemetry-readout.md");

    for (const expected of [
      "Where does setup fail?",
      "Which surfaces are active?",
      "Is local or generic remote runtime worth more investment?",
      "Are native integrations used?",
      "Which exposure modes are used?",
      "Which backend families deserve investment?",
      "Is Code Mode succeeding?",
      "What reliability pressure is highest?",
      "caplets_cli_command",
      "caplets_tool_activation",
      "caplets_code_mode_outcome",
      "caplets_reliability_error",
      "caplets_site_pageview",
      "caplets_site_intent",
      "caplets_catalog_search",
      "caplets_install_intent",
      "attribution_source",
      "first_activation",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toMatch(/session replay.*in scope/iu);
    expect(text).not.toMatch(/known-user.*in scope/iu);
  });
});
