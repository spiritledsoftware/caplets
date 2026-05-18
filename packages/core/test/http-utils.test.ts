import { describe, expect, it } from "vitest";
import { parseHttpBody } from "../src/http/utils";

describe("http utils", () => {
  it("parses HTTP bodies by media type", () => {
    expect(parseHttpBody("application/json; charset=utf-8", '{"ok":true}')).toEqual({ ok: true });
    expect(parseHttpBody("application/graphql-response+json", '{"data":{}}')).toEqual({
      data: {},
    });
    expect(parseHttpBody("text/plain", "hello")).toBe("hello");
  });
});
