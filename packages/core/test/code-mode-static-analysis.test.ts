import { describe, expect, it } from "vitest";
import { hasDirectFetchCall, hasExecutableImport } from "../src/code-mode/static-analysis";

describe("Code Mode static analysis", () => {
  it("detects direct fetch calls without blocking text or member fetch calls", () => {
    expect(hasDirectFetchCall('await fetch("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall('return await fetch("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall('await globalThis.fetch("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall('await globalThis["fetch"]("https://example.com");')).toBe(true);
    expect(hasDirectFetchCall("const f = fetch;")).toBe(true);
    expect(hasDirectFetchCall("const f = globalThis.fetch;")).toBe(true);
    expect(hasDirectFetchCall('const f = globalThis["fetch"];')).toBe(true);
    expect(hasDirectFetchCall("const f = window.fetch;")).toBe(true);
    expect(hasDirectFetchCall("const f = self.fetch;")).toBe(true);
    expect(hasDirectFetchCall('const note = "await fetch(\\"https://example.com\\")";')).toBe(
      false,
    );
    expect(
      hasDirectFetchCall("const fetch = client.fetch; await globalThis[fetch]('/issues');"),
    ).toBe(false);
    expect(hasDirectFetchCall("const result = client.fetch('/issues');")).toBe(false);
    expect(hasDirectFetchCall("const f = client.fetch;")).toBe(false);
  });

  it.each([
    ["fetch.call", 'await fetch.call(globalThis, "https://example.com");'],
    ["fetch.apply", 'await fetch.apply(globalThis, ["https://example.com"]);'],
    ["fetch.bind", "const blocked = fetch.bind(globalThis);"],
    ["globalThis.fetch.call", 'await globalThis.fetch.call(globalThis, "https://example.com");'],
    [
      "globalThis.fetch.apply",
      'await globalThis.fetch.apply(globalThis, ["https://example.com"]);',
    ],
    ["globalThis.fetch.bind", "const blocked = globalThis.fetch.bind(globalThis);"],
    [
      'globalThis["fetch"].call',
      'await globalThis["fetch"].call(globalThis, "https://example.com");',
    ],
    [
      'globalThis["fetch"].apply',
      'await globalThis["fetch"].apply(globalThis, ["https://example.com"]);',
    ],
    ['globalThis["fetch"].bind', 'const blocked = globalThis["fetch"].bind(globalThis);'],
    ["window.fetch.call", 'await window.fetch.call(window, "https://example.com");'],
    ["window.fetch.apply", 'await window.fetch.apply(window, ["https://example.com"]);'],
    ["window.fetch.bind", "const blocked = window.fetch.bind(window);"],
    ["self.fetch.call", 'await self.fetch.call(self, "https://example.com");'],
    ["self.fetch.apply", 'await self.fetch.apply(self, ["https://example.com"]);'],
    ["self.fetch.bind", "const blocked = self.fetch.bind(self);"],
  ])("detects indirect fetch calls through %s", (_name, code) => {
    expect(hasDirectFetchCall(code)).toBe(true);
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
