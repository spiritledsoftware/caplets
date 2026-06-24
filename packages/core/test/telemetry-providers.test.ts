import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProductTelemetryEvent,
  buildReliabilityTelemetryEvent,
  createTelemetryDispatcher,
  readTelemetryDeliveryHealth,
  resolveTelemetryState,
} from "../src/telemetry";

const roots: string[] = [];

function tempRoot(): string {
  const root = join(mkdtempSync(join(tmpdir(), "caplets-telemetry-providers-")), "state");
  roots.push(root);
  return root;
}

describe("telemetry providers", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not construct SDK clients for disabled, test, or debug state", async () => {
    const factory = vi.fn();
    const dispatcher = createTelemetryDispatcher({
      posthogToken: "ph_project",
      sentryDsn: "https://public@sentry.example/1",
      factories: { createPostHog: factory, createSentry: factory },
    });
    const product = buildProductTelemetryEvent({
      name: "caplets_cli_command",
      distinctId: "anon_1234567890abcdef1234567890abcdef",
      properties: { surface: "cli", execution_context: "interactive" },
    });

    await dispatcher.capture(
      resolveTelemetryState({
        stateDir: tempRoot(),
        env: { CAPLETS_DISABLE_TELEMETRY: "1" },
        surface: "cli",
        visibility: "visible",
      }),
      product,
    );
    await dispatcher.capture(
      resolveTelemetryState({
        stateDir: tempRoot(),
        env: { VITEST: "true" },
        surface: "cli",
        visibility: "visible",
      }),
      product,
    );
    await dispatcher.capture(
      resolveTelemetryState({
        stateDir: tempRoot(),
        env: {},
        surface: "cli",
        visibility: "visible",
        debug: true,
      }),
      product,
    );

    expect(factory).not.toHaveBeenCalled();
  });

  it("captures PostHog events with anonymous profile and GeoIP disabled", async () => {
    const capture = vi.fn();
    const stateDir = tempRoot();
    const dispatcher = createTelemetryDispatcher({
      posthogToken: "ph_project",
      sentryDsn: "",
      factories: {
        createPostHog: vi.fn(() => ({ capture, shutdown: vi.fn() })),
      },
    });
    const state = resolveTelemetryState({
      stateDir,
      env: { CI: "true" },
      surface: "cli",
      visibility: "hidden",
    });

    await dispatcher.capture(
      state,
      buildProductTelemetryEvent({
        name: "caplets_cli_command",
        distinctId: state.identity!.id,
        properties: { surface: "cli", execution_context: "ci" },
      }),
    );

    expect(capture).toHaveBeenCalledWith({
      distinctId: state.identity!.id,
      event: "caplets_cli_command",
      properties: {
        $geoip_disable: true,
        $process_person_profile: false,
        surface: "cli",
        execution_context: "ci",
      },
    });
  });

  it("captures Sentry reliability events with categorical tags and fingerprint", async () => {
    const captureEvent = vi.fn();
    const dispatcher = createTelemetryDispatcher({
      posthogToken: "",
      sentryDsn: "https://public@sentry.example/1",
      factories: {
        createSentry: vi.fn(() => ({ captureEvent, flush: vi.fn() })),
      },
    });
    const state = resolveTelemetryState({
      stateDir: tempRoot(),
      env: { CI: "true" },
      surface: "cli",
      visibility: "hidden",
    });

    await dispatcher.capture(
      state,
      buildReliabilityTelemetryEvent({
        name: "caplets_reliability_error",
        properties: {
          package: "@caplets/core",
          surface: "cli",
          command_family: "serve",
          runtime_mode: "local",
          error_code: "CONFIG_INVALID",
          diagnostic_category: "config",
        },
      }),
    );

    expect(captureEvent).toHaveBeenCalledWith({
      level: "error",
      tags: {
        package: "@caplets/core",
        surface: "cli",
        command_family: "serve",
        runtime_mode: "local",
        error_code: "CONFIG_INVALID",
        diagnostic_category: "config",
      },
      fingerprint: ["@caplets/core", "cli", "serve", "local", "CONFIG_INVALID", "config"],
    });
  });

  it("records delivery health instead of throwing when provider send fails", async () => {
    const stateDir = tempRoot();
    const dispatcher = createTelemetryDispatcher({
      posthogToken: "ph_project",
      sentryDsn: "",
      factories: {
        createPostHog: vi.fn(() => ({
          capture: vi.fn(() => {
            throw new Error("network");
          }),
          shutdown: vi.fn(),
        })),
      },
    });
    const state = resolveTelemetryState({
      stateDir,
      env: { CI: "true" },
      surface: "cli",
      visibility: "hidden",
    });

    await dispatcher.capture(
      state,
      buildProductTelemetryEvent({
        name: "caplets_cli_command",
        distinctId: state.identity!.id,
        properties: { surface: "cli", execution_context: "ci" },
      }),
    );

    expect(readTelemetryDeliveryHealth({ stateDir })).toEqual({
      posthog: { send_failed: 1 },
    });
  });
});
