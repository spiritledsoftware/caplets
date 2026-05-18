import { describe, expect, it } from "vitest";
import { isAllowedRemoteUrl } from "../src/config/validation";

describe("config validation helpers", () => {
  it("returns false for malformed remote URLs", () => {
    expect(isAllowedRemoteUrl("not a url")).toBe(false);
  });

  it("allows https and loopback http only", () => {
    expect(isAllowedRemoteUrl("https://example.com/mcp")).toBe(true);
    expect(isAllowedRemoteUrl("http://localhost:3000/mcp")).toBe(true);
    expect(isAllowedRemoteUrl("http://example.com/mcp")).toBe(false);
  });
});
