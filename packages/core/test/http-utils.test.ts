import { describe, expect, it } from "vitest";
import { parseHttpBody } from "../src/http/utils";

describe("http utils", () => {
  it("parses JSON and structured JSON media types", () => {
    expect(parseHttpBody("application/json; charset=utf-8", '{"ok":true}')).toEqual({ ok: true });
    expect(parseHttpBody("application/graphql-response+json", '{"data":{}}')).toEqual({
      data: {},
    });
  });

  it("leaves non-JSON bodies as text", () => {
    expect(parseHttpBody("text/plain", "hello")).toBe("hello");
  });
});
