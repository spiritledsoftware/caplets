import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildNodeOptions } from "./alchemy-runner.mjs";

const shimPath = fileURLToPath(new URL("./alchemy-fetch-compat.mjs", import.meta.url));

test("Alchemy runner injects fetch shim through NODE_OPTIONS for child processes", () => {
  assert.equal(buildNodeOptions(undefined), `--import=${shimPath}`);
});

test("Alchemy runner preserves existing NODE_OPTIONS after the fetch shim", () => {
  assert.equal(buildNodeOptions("--trace-warnings"), `--import=${shimPath} --trace-warnings`);
});
