import { describe, expect, it } from "vitest";
import { classifyUpdateNoticeEligibility } from "../src/update-check";

describe("update-check eligibility", () => {
  it("keeps attach stdio quiet unless stderr notices are explicitly opted in", () => {
    expect(
      classifyUpdateNoticeEligibility({
        args: ["attach"],
        env: {},
        stderrIsTTY: true,
      }),
    ).toMatchObject({ eligible: false, reason: "stdio" });

    expect(
      classifyUpdateNoticeEligibility({
        args: ["attach"],
        env: { CAPLETS_UPDATE_NOTICE_STDERR: "1" },
        stderrIsTTY: false,
      }),
    ).toMatchObject({ eligible: true, command: "attach" });
  });

  it("allows foreground HTTP serve when stderr is human-facing", () => {
    expect(
      classifyUpdateNoticeEligibility({
        args: ["serve", "--transport", "http"],
        env: {},
        stderrIsTTY: true,
      }),
    ).toMatchObject({ eligible: true, command: "serve" });
  });

  it("does not let stdio opt-in override output-product suppression", () => {
    expect(
      classifyUpdateNoticeEligibility({
        args: ["attach", "--once", "--json"],
        env: { CAPLETS_UPDATE_NOTICE_STDERR: "1" },
        stderrIsTTY: false,
      }),
    ).toMatchObject({ eligible: false, reason: "output_product" });
  });

  it("suppresses uppercase JSON format values and config path outputs", () => {
    for (const args of [
      ["list-tools", "--format=JSON"],
      ["list-tools", "--format", "JSON"],
      ["config", "path"],
      ["config", "paths"],
      ["telemetry", "debug", "--", "setup"],
    ]) {
      expect(
        classifyUpdateNoticeEligibility({
          args,
          stderrIsTTY: true,
        }),
      ).toMatchObject({ eligible: false, reason: "output_product" });
    }
  });

  it("treats CI=1 as a CI context", () => {
    expect(
      classifyUpdateNoticeEligibility({
        args: ["telemetry", "status"],
        env: { CI: "1" },
        stderrIsTTY: true,
      }),
    ).toMatchObject({ eligible: false, reason: "ci" });
  });
});
