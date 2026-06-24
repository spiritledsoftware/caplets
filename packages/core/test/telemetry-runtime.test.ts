import { describe, expect, it } from "vitest";
import {
  codeModeTelemetryProperties,
  operationFamilyFromOperation,
  outcomeFromResult,
} from "../src/telemetry";

describe("telemetry runtime helpers", () => {
  it("maps current runtime operation names into stable families", () => {
    expect(operationFamilyFromOperation("describe_tool")).toBe("tools");
    expect(operationFamilyFromOperation("search_resources")).toBe("resources");
    expect(operationFamilyFromOperation("search_prompts")).toBe("prompts");
  });

  it("classifies timeout-shaped error codes as timeouts", () => {
    expect(outcomeFromResult({ ok: false, error: { code: "sandbox_timeout" } })).toBe("timeout");
  });

  it("reports Code Mode caplet invocation from run metadata", () => {
    expect(
      codeModeTelemetryProperties(
        {
          ok: true,
          meta: { sessionStatus: "created", anyCapletInvoked: true },
        },
        50,
        1_000,
      ),
    ).toMatchObject({
      command_family: "code_mode",
      any_caplet_invoked: true,
    });
  });
});
