import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";

import { buildNodeOptions } from "./alchemy-runner";

const shimPath = fileURLToPath(new URL("./alchemy-fetch-compat.ts", import.meta.url));

test("Alchemy runner injects fetch shim through NODE_OPTIONS for child processes", () => {
  expect(buildNodeOptions(undefined)).toBe(`--import=${shimPath}`);
});

test("Alchemy runner preserves existing NODE_OPTIONS after the fetch shim", () => {
  expect(buildNodeOptions("--trace-warnings")).toBe(`--import=${shimPath} --trace-warnings`);
});
