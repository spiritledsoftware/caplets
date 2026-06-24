import { describe, expect, it } from "vitest";
import {
  codeModeTelemetryProperties,
  operationFamilyFromOperation,
  outcomeFromResult,
  runtimeFailureTelemetryProperties,
} from "../src/telemetry";

describe("telemetry runtime helpers", () => {
  it("maps current runtime operation names into stable families", () => {
    expect(operationFamilyFromOperation("describe_tool")).toBe("tools");
    expect(operationFamilyFromOperation("search_resources")).toBe("resources");
    expect(operationFamilyFromOperation("search_prompts")).toBe("prompts");
  });

  it("classifies timeout-shaped error codes as timeouts", () => {
    expect(outcomeFromResult({ ok: false, error: { code: "sandbox_timeout" } })).toBe("timeout");
    expect(
      outcomeFromResult({
        isError: true,
        structuredContent: { error: { code: "OPERATION_TIMEOUT" } },
      }),
    ).toBe("timeout");
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

  it("uses Code Mode envelope timeout and one-shot session metadata", () => {
    expect(
      codeModeTelemetryProperties(
        {
          ok: true,
          meta: { sessionStatus: null, timeoutMs: 10_000 },
        },
        50,
        undefined,
      ),
    ).toMatchObject({
      timeout_bucket: "lt_60s",
      session_category: "none",
    });
  });

  it("reads reliability codes from structured MCP error content", () => {
    expect(
      runtimeFailureTelemetryProperties({
        operation: "call_tool",
        exposureMode: "progressive",
        result: {
          isError: true,
          structuredContent: { error: { code: "REQUEST_INVALID" } },
        },
      }),
    ).toMatchObject({ error_code: "REQUEST_INVALID", diagnostic_category: "validation" });
  });
});
