import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config";
import {
  captureRuntimeTelemetryEvent,
  codeModeTelemetryProperties,
  operationFamilyFromOperation,
  outcomeFromResult,
  readTelemetryAttribution,
  runtimeFailureTelemetryProperties,
  TelemetryDebugSink,
  writeTelemetryAttribution,
} from "../src/telemetry";

const roots: string[] = [];

function tempRoot(): string {
  const root = join(mkdtempSync(join(tmpdir(), "caplets-telemetry-runtime-")), "state");
  roots.push(root);
  return root;
}

describe("telemetry runtime helpers", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it("attaches stored install attribution to the first successful enabled product event", async () => {
    const stateDir = tempRoot();
    const capture = vi.fn();
    writeTelemetryAttribution({ stateDir, marker: "docs_install" });

    await captureRuntimeTelemetryEvent(
      {
        config: parseConfig({ telemetry: true }),
        env: { CI: "true" },
        stateDir,
        surface: "cli",
        visibility: "hidden",
        dispatcher: { capture, shutdown: vi.fn() },
      },
      "caplets_cli_command",
      {
        command_family: "setup",
        outcome: "success",
      },
    );

    expect(capture.mock.calls[0]?.[1].properties).toMatchObject({
      attribution_source: "docs",
      attribution_intent: "install_run",
      first_activation: true,
    });
    expect(readTelemetryAttribution({ stateDir })).toBeUndefined();
  });

  it("keeps stored install attribution when product delivery fails", async () => {
    const stateDir = tempRoot();
    writeTelemetryAttribution({ stateDir, marker: "catalog_install" });

    await expect(
      captureRuntimeTelemetryEvent(
        {
          config: parseConfig({ telemetry: true }),
          env: { CI: "true" },
          stateDir,
          surface: "cli",
          visibility: "hidden",
          dispatcher: {
            capture: vi.fn().mockRejectedValue(new Error("send failed")),
            shutdown: vi.fn(),
          },
        },
        "caplets_cli_command",
        {
          command_family: "setup",
          outcome: "success",
        },
      ),
    ).rejects.toThrow(/send failed/u);

    expect(readTelemetryAttribution({ stateDir })).toMatchObject({ source: "catalog" });
  });

  it("attaches env install attribution to only one successful runtime event", async () => {
    const stateDir = tempRoot();
    const capture = vi.fn();
    const env = { CI: "true", CAPLETS_INSTALL_ATTRIBUTION: "landing_install" };
    const context = {
      config: parseConfig({ telemetry: true }),
      env,
      stateDir,
      surface: "cli" as const,
      visibility: "hidden" as const,
      dispatcher: { capture, shutdown: vi.fn() },
    };

    await captureRuntimeTelemetryEvent(context, "caplets_cli_command", {
      command_family: "setup",
      outcome: "success",
    });
    await captureRuntimeTelemetryEvent(context, "caplets_cli_command", {
      command_family: "setup",
      outcome: "success",
    });

    expect(capture.mock.calls[0]?.[1].properties).toMatchObject({
      attribution_source: "landing",
      first_activation: true,
    });
    expect(capture.mock.calls[1]?.[1].properties).not.toHaveProperty("attribution_source");
  });

  it("does not leak install attribution through local telemetry debug output", async () => {
    const stateDir = tempRoot();
    const sink = new TelemetryDebugSink();
    writeTelemetryAttribution({ stateDir, marker: "landing_install" });

    await captureRuntimeTelemetryEvent(
      {
        config: parseConfig({ telemetry: true }),
        env: { CAPLETS_TELEMETRY_DEBUG: "1" },
        stateDir,
        surface: "cli",
        visibility: "visible",
        debugSink: sink,
        dispatcher: { capture: vi.fn(), shutdown: vi.fn() },
      },
      "caplets_cli_command",
      {
        command_family: "setup",
        outcome: "success",
      },
    );

    expect(JSON.stringify(sink.records)).not.toContain("attribution");
    expect(readTelemetryAttribution({ stateDir })).toMatchObject({ source: "landing" });
  });
});
