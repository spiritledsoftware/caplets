import { describe, expect, it } from "vitest";
import { isRuntimeResourceClassAllowed, resourceClassRank } from "../src/runtime-plan";

describe("shared Worker-safe helpers", () => {
  it("sorts object keys stably and omits undefined values", async () => {
    const { stableJsonSha256Hex, stableJsonStringify, stableJsonValue } =
      await import("../src/stable-json");

    expect(stableJsonValue({ b: 2, a: undefined, c: { z: 1, y: 2 } })).toEqual({
      b: 2,
      c: { y: 2, z: 1 },
    });
    expect(stableJsonStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    await expect(stableJsonSha256Hex({ b: 2, a: 1 })).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });

  it("redacts shared secret keys and text patterns", async () => {
    const { isSecretKey, redactSecretText, redactUnknownSecrets } =
      await import("../src/redaction");

    expect(isSecretKey("refresh_token")).toBe(true);
    expect(redactSecretText("Authorization: Bearer secret-token-value").text).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(
      redactSecretText("stripe sk_live_123", { patterns: [/sk_(?:live|test)_[0-9A-Za-z._-]+/gu] })
        .text,
    ).toBe("stripe [REDACTED]");
    expect(redactUnknownSecrets({ refreshToken: "abc", nested: ["Bearer abcdefgh"] })).toEqual({
      refreshToken: "[REDACTED]",
      nested: ["Bearer [REDACTED]"],
    });
  });

  it("shares runtime resource class ordering", () => {
    expect(resourceClassRank("small")).toBeLessThan(resourceClassRank("medium"));
    expect(resourceClassRank("standard")).toBe(resourceClassRank("medium"));
    expect(isRuntimeResourceClassAllowed("medium", "small")).toBe(false);
    expect(isRuntimeResourceClassAllowed("standard", "medium")).toBe(true);
  });
});
