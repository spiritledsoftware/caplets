import { describe, expect, it } from "vitest";
import { assertTelemetrySafeProperties, stripSentryEvent } from "../src/telemetry";

describe("telemetry privacy guard", () => {
  it("rejects unsafe string values before provider calls", () => {
    expect(() =>
      assertTelemetrySafeProperties({
        surface: "cli",
        command_family: "setup",
        path_like: "/Users/alex/.config/caplets/config.json",
      } as never),
    ).toThrow(/unknown telemetry property/u);

    expect(() =>
      assertTelemetrySafeProperties({
        surface: "cli",
        command_family: "setup",
        error_code: "TOKEN=secret",
      }),
    ).toThrow(/unsafe telemetry property/u);

    expect(() =>
      assertTelemetrySafeProperties({
        surface: "cli",
        command_family: "workspace-slug",
      } as never),
    ).toThrow(/unsafe telemetry property/u);
  });

  it("strips Sentry event message, exception, breadcrumbs, request, and extra data", () => {
    expect(
      stripSentryEvent({
        message: "Raw /tmp/path message",
        exception: { values: [{ stacktrace: { frames: [{ filename: "/tmp/x.ts" }] } }] },
        request: { url: "https://example.com" },
        breadcrumbs: [{ message: "secret" }],
        extra: { args: ["--token", "secret"] },
        tags: { surface: "cli" },
        fingerprint: ["@caplets/core", "cli"],
      }),
    ).toEqual({
      tags: { surface: "cli" },
      fingerprint: ["@caplets/core", "cli"],
    });
  });
});
