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
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("maps decision questions to allowlisted event families", () => {
    const text = read("docs/product/telemetry-readout.md");

    for (const expected of [
      "Where does setup fail?",
      "Which surfaces are active?",
      "Is local, remote, or cloud runtime worth more investment?",
      "Are native integrations used?",
      "Which exposure modes are used?",
      "Which backend families deserve investment?",
      "Is Code Mode succeeding?",
      "What reliability pressure is highest?",
      "caplets_cli_command",
      "caplets_runtime_lifecycle",
      "caplets_tool_activation",
      "caplets_code_mode_outcome",
      "caplets_reliability_error",
      "caplets_delivery_health",
    ]) {
      expect(text).toContain(expected);
    }
  });
});
