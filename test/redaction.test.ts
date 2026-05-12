import { describe, expect, it } from "vitest";
import { CapletsError, redactSecrets, toSafeError } from "../src/errors.js";

describe("redaction", () => {
  it("redacts secret-looking fields and bearer values", () => {
    expect(
      redactSecrets({
        token: "abc",
        nested: { Authorization: "Bearer abc.def", url: "https://x.test?a=1&code=secret" },
      }),
    ).toEqual({
      token: "[REDACTED]",
      nested: { Authorization: "[REDACTED]", url: "https://x.test?a=1&code=[REDACTED]" },
    });
  });

  it("serializes structured errors safely", () => {
    expect(
      toSafeError(new CapletsError("AUTH_FAILED", "Bearer abc failed", { refreshToken: "secret" })),
    ).toEqual({
      code: "AUTH_FAILED",
      message: "Bearer [REDACTED] failed",
      details: { refreshToken: "[REDACTED]" },
    });
  });
});
