import { describe, expect, it } from "vitest";
import {
  buildProductTelemetryEvent,
  buildReliabilityTelemetryEvent,
  durationBucket,
  timeoutBucket,
} from "../src/telemetry";

describe("telemetry event builders", () => {
  it("builds allowlisted product events with categorical properties", () => {
    expect(
      buildProductTelemetryEvent({
        name: "caplets_cli_command",
        distinctId: "anon_1234567890abcdef1234567890abcdef",
        properties: {
          package: "@caplets/core",
          version: "0.27.0",
          surface: "cli",
          runtime_mode: "local",
          execution_context: "interactive",
          command_family: "setup",
          outcome: "success",
          duration_bucket: "lt_1s",
        },
      }),
    ).toEqual({
      provider: "posthog",
      name: "caplets_cli_command",
      distinctId: "anon_1234567890abcdef1234567890abcdef",
      properties: {
        $process_person_profile: false,
        package: "@caplets/core",
        version: "0.27.0",
        surface: "cli",
        runtime_mode: "local",
        execution_context: "interactive",
        command_family: "setup",
        outcome: "success",
        duration_bucket: "lt_1s",
      },
    });
  });

  it("forces anonymous product profile behavior after caller properties", () => {
    const event = buildProductTelemetryEvent({
      name: "caplets_cli_command",
      distinctId: "anon_1234567890abcdef1234567890abcdef",
      properties: {
        surface: "cli",
        $process_person_profile: true,
      } as never,
    });

    expect(event.properties.$process_person_profile).toBe(false);
  });

  it("rejects unknown event and property keys", () => {
    expect(() =>
      buildProductTelemetryEvent({
        name: "unknown" as never,
        distinctId: "anon_1234567890abcdef1234567890abcdef",
        properties: { surface: "cli" },
      }),
    ).toThrow(/unknown telemetry event/u);

    expect(() =>
      buildProductTelemetryEvent({
        name: "caplets_cli_command",
        distinctId: "anon_1234567890abcdef1234567890abcdef",
        properties: { raw_path: "/tmp/secret" } as never,
      }),
    ).toThrow(/unknown telemetry property/u);
  });

  it("rejects the removed Cloud runtime mode", () => {
    expect(() =>
      buildProductTelemetryEvent({
        name: "caplets_cli_command",
        distinctId: "anon_1234567890abcdef1234567890abcdef",
        properties: { runtime_mode: "cloud" } as never,
      }),
    ).toThrow(/unsafe telemetry property/u);
  });

  it("rejects path, URL, hostname, env, token, and id-shaped raw values", () => {
    for (const value of [
      "/home/ian/project",
      "https://example.com/token",
      "api.internal.example.com",
      "sk-abc123456789",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "CAPLETS_REMOTE_URL=https://example.com",
    ]) {
      expect(() =>
        buildProductTelemetryEvent({
          name: "caplets_cli_command",
          distinctId: "anon_1234567890abcdef1234567890abcdef",
          properties: { surface: value } as never,
        }),
      ).toThrow(/unsafe telemetry property/u);
    }
  });

  it("allows one-shot categorical attribution fields on product events", () => {
    const event = buildProductTelemetryEvent({
      name: "caplets_cli_command",
      distinctId: "anon_1234567890abcdef1234567890abcdef",
      properties: {
        surface: "cli",
        command_family: "setup",
        outcome: "success",
        attribution_source: "landing",
        attribution_intent: "install_run",
        first_activation: true,
      },
    });

    expect(event.properties).toMatchObject({
      attribution_source: "landing",
      attribution_intent: "install_run",
      first_activation: true,
    });
  });

  it("rejects unknown or raw attribution values", () => {
    expect(() =>
      buildProductTelemetryEvent({
        name: "caplets_cli_command",
        distinctId: "anon_1234567890abcdef1234567890abcdef",
        properties: {
          attribution_source: "https://landing.example/install",
          attribution_intent: "install_run",
        } as never,
      }),
    ).toThrow(/unsafe telemetry property/u);
    expect(() =>
      buildProductTelemetryEvent({
        name: "caplets_cli_command",
        distinctId: "anon_1234567890abcdef1234567890abcdef",
        properties: { attribution_campaign: "launch" } as never,
      }),
    ).toThrow(/unknown telemetry property/u);
  });

  it("builds reliability events with sanitized stack frames but no raw message or details", () => {
    const error = new Error("CONFIG_INVALID at /home/alex/project/.caplets/config.json");
    error.stack = [
      "Error: CONFIG_INVALID at /home/alex/project/.caplets/config.json",
      "    at loadConfig (/home/alex/caplets/packages/core/src/config/index.ts:12:5)",
      "    at request (https://api.internal.example.com/token?value=sk-secret:8:9)",
      "    at runner (/home/alex/caplets/node_modules/@scope/pkg/dist/index.js:2:3)",
    ].join("\n");

    expect(
      buildReliabilityTelemetryEvent({
        name: "caplets_reliability_error",
        properties: {
          package: "@caplets/core",
          version: "0.27.0",
          surface: "cli",
          runtime_mode: "local",
          command_family: "serve",
          error_code: "CONFIG_INVALID",
          diagnostic_category: "config",
          os_family: "linux",
          arch: "x64",
          runtime_name: "node",
          runtime_major: 22,
        },
        error,
      }),
    ).toMatchObject({
      provider: "sentry",
      name: "caplets_reliability_error",
      fingerprint: ["@caplets/core", "cli", "serve", "local", "CONFIG_INVALID", "config"],
      tags: {
        package: "@caplets/core",
        version: "0.27.0",
        surface: "cli",
        runtime_mode: "local",
        command_family: "serve",
        error_code: "CONFIG_INVALID",
        diagnostic_category: "config",
        os_family: "linux",
        arch: "x64",
        runtime_name: "node",
        runtime_major: "22",
      },
      exception: {
        values: [
          {
            type: "Error",
            stacktrace: {
              frames: expect.arrayContaining([
                expect.objectContaining({
                  filename: "packages/core/src/config/index.ts",
                  function: "loadConfig",
                  lineno: 12,
                  colno: 5,
                }),
                expect.objectContaining({
                  filename: "node_modules/@scope/pkg/dist/index.js",
                  function: "runner",
                }),
              ]),
            },
          },
        ],
      },
    });
    const serialized = JSON.stringify(
      buildReliabilityTelemetryEvent({
        name: "caplets_reliability_error",
        properties: {
          package: "@caplets/core",
          version: "0.27.0",
          surface: "cli",
          runtime_mode: "local",
          command_family: "serve",
          error_code: "CONFIG_INVALID",
          diagnostic_category: "config",
        },
        error,
      }),
    );
    expect(serialized).not.toContain("/home/alex");
    expect(serialized).not.toContain("api.internal.example.com");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("CONFIG_INVALID at");
  });

  it("buckets duration and timeout values", () => {
    expect(durationBucket(50)).toBe("lt_100ms");
    expect(durationBucket(999)).toBe("lt_1s");
    expect(durationBucket(4_000)).toBe("lt_5s");
    expect(durationBucket(30_000)).toBe("gte_30s");
    expect(timeoutBucket(undefined)).toBe("none");
    expect(timeoutBucket(500)).toBe("lt_1s");
    expect(timeoutBucket(90_000)).toBe("gte_60s");
  });
});
