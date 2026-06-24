import { describe, expect, it } from "vitest";
import { classifyUpdateNoticeEligibility } from "../src/update-check";

describe("update-check eligibility", () => {
  it("keeps attach stdio quiet unless stderr notices are explicitly opted in", () => {
    expect(
      classifyUpdateNoticeEligibility({
        args: ["attach"],
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
});
