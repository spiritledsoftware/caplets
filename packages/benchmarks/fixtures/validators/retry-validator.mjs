import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const retryModuleUrl = pathToFileURL(join(process.cwd(), "src", "retry.js"));
const { getRetryDelay, shouldRetry } = await import(retryModuleUrl);

test("validates complete retry policy", () => {
  assert.deepEqual([1, 2, 3].map(getRetryDelay), [100, 250, 500]);
  assert.equal(getRetryDelay(0), null);
  assert.equal(getRetryDelay(4), null);

  for (const statusCode of [408, 429, 500, 502, 503, 504]) {
    assert.equal(shouldRetry(statusCode), true, `${statusCode} should be retried`);
  }

  for (const statusCode of [200, 201, 400, 401, 403, 404, 409, 422]) {
    assert.equal(shouldRetry(statusCode), false, `${statusCode} should not be retried`);
  }
});
