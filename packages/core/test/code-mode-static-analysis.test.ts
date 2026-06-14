import { describe, expect, it } from "vitest";
import { hasDirectFetchCall, hasExecutableImport } from "../src/code-mode/static-analysis";

describe("Code Mode static analysis", () => {
  it("detects direct fetch calls without blocking text or member fetch calls", () => {
    expect(hasDirectFetchCall('await fetch("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall('return await fetch("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall('await globalThis.fetch("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall('await globalThis["fetch"]("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall('const note = "await fetch(\\"https://example.com\\")";')).toBe(
      false,
    );
    expect(
      hasDirectFetchCall("const fetch = client.fetch; await globalThis[fetch]('/issues');"),
    ).toBe(false);
    expect(hasDirectFetchCall("const result = client.fetch('/issues');")).toBe(false);
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
