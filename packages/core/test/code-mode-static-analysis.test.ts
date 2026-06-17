import { describe, expect, it } from "vitest";
import { hasDirectFetchCall, hasExecutableImport } from "../src/code-mode/static-analysis";

describe("Code Mode static analysis", () => {
  it("detects direct fetch calls without blocking text or member fetch calls", () => {
    expect(hasDirectFetchCall('await fetch("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall('return await fetch("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall('await globalThis.fetch("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall('await globalThis["fetch"]("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall('await window.fetch("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall('await self.fetch("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall("const f = fetch;")).toBe(false);
    expect(hasDirectFetchCall("const f = globalThis.fetch;")).toBe(false);
    expect(hasDirectFetchCall('const f = globalThis["fetch"];')).toBe(false);
    expect(hasDirectFetchCall("const f = window.fetch;")).toBe(false);
    expect(hasDirectFetchCall("const f = self.fetch;")).toBe(false);
    expect(hasDirectFetchCall('const note = "await fetch(\\"https://example.com\\")";')).toBe(
      false,
    );
    expect(
      hasDirectFetchCall("const fetch = client.fetch; await globalThis[fetch]('/issues');"),
    ).toBe(false);
    expect(hasDirectFetchCall("const result = client.fetch('/issues');")).toBe(false);
    expect(hasDirectFetchCall("const f = client.fetch;")).toBe(false);
  });

  it("does not chase fetch aliases or wrapper methods", () => {
    expect(hasDirectFetchCall('await fetch.call(globalThis, "https://example.com");')).toBe(false);
    expect(
      hasDirectFetchCall('await globalThis.fetch.call(globalThis, "https://example.com");'),
    ).toBe(false);
    expect(hasDirectFetchCall("const f = fetch; await f('/issues');")).toBe(false);
  });

  it("detects executable imports without blocking import text", () => {
    expect(hasExecutableImport('import fs from "node:fs";')).toBe(true);
    expect(hasExecutableImport('import { readFile } from "node:fs";')).toBe(true);
    expect(hasExecutableImport('import "node:fs";')).toBe(true);
    expect(hasExecutableImport('await import("node:fs");')).toBe(true);
    expect(hasExecutableImport('return await import("node:fs");')).toBe(true);
    expect(hasExecutableImport('export { readFile } from "node:fs";')).toBe(true);
    expect(hasExecutableImport('const note = "import fs from node:fs";')).toBe(false);
    expect(hasExecutableImport("const value = 1; export { value };")).toBe(false);
    expect(hasExecutableImport("const result = client.import('value');")).toBe(false);
  });
});
