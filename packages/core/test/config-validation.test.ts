import { describe, expect, it } from "vitest";
import { isAllowedRemoteUrl } from "../src/config/validation";

describe("config validation helpers", () => {
  it("allows only valid HTTPS and loopback HTTP remote URLs", () => {
    expect(isAllowedRemoteUrl("not a url")).toBe(false);
    expect(isAllowedRemoteUrl("https://example.com/mcp")).toBe(true);
    expect(isAllowedRemoteUrl("http://localhost:3000/mcp")).toBe(true);
    expect(isAllowedRemoteUrl("http://example.com/mcp")).toBe(false);
  });
});
