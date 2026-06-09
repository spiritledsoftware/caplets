import assert from "node:assert/strict";
import test from "node:test";

import { getRetryDelay, shouldRetry } from "../src/retry.js";

test("exports retry helpers", () => {
  assert.equal(typeof getRetryDelay, "function");
  assert.equal(typeof shouldRetry, "function");
});

test("returns null beyond configured attempts", () => {
  assert.equal(getRetryDelay(4), null);
});

test("rejects non-retryable responses", () => {
  assert.equal(shouldRetry(404), false);
});
