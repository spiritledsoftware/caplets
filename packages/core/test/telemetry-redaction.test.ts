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

  it("strips Sentry event message, unsafe exception frames, breadcrumbs, request, and extra data", () => {
    expect(
      stripSentryEvent({
        message: "Raw /tmp/path message",
        exception: {
          values: [
            {
              type: "Error",
              stacktrace: {
                frames: [
                  {
                    filename: "/tmp/x.ts",
                    function: "leak",
                    lineno: 1,
                  },
                  {
                    filename: "packages/core/src/config/index.ts",
                    function: "loadConfig",
                    lineno: 12,
                    colno: 5,
                    in_app: true,
                  },
                ],
              },
            },
          ],
        },
        request: { url: "https://example.com" },
        breadcrumbs: [{ message: "secret" }],
        extra: { args: ["--token", "secret"] },
        tags: { surface: "cli" },
        fingerprint: ["@caplets/core", "cli"],
      }),
    ).toEqual({
      tags: { surface: "cli" },
      fingerprint: ["@caplets/core", "cli"],
      exception: {
        values: [
          {
            type: "Error",
            stacktrace: {
              frames: [
                {
                  filename: "packages/core/src/config/index.ts",
                  function: "loadConfig",
                  lineno: 12,
                  colno: 5,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
    });
  });

  it("does not preserve traversal inside workspace-looking frame paths", () => {
    const event = stripSentryEvent({
      exception: {
        values: [
          {
            type: "Error",
            stacktrace: {
              frames: [
                {
                  filename: "/tmp/packages/../../secret/config.ts",
                  function: "loadConfig",
                  lineno: 7,
                },
              ],
            },
          },
        ],
      },
    });

    expect(JSON.stringify(event)).not.toContain("packages/../../secret");
    expect(event).toMatchObject({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [{ filename: "config.ts", function: "loadConfig", lineno: 7 }],
            },
          },
        ],
      },
    });
  });
});
