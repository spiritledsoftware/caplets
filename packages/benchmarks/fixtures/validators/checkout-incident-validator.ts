import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const retryModuleUrl = pathToFileURL(join(process.cwd(), "src", "retry.js"));
const checkoutModuleUrl = pathToFileURL(join(process.cwd(), "src", "checkout-authorization.js"));
const { getRetryDelay, shouldRetry } = await import(retryModuleUrl.href);
const { authorizeCheckout } = await import(checkoutModuleUrl.href);

test("validates checkout incident retry hardening", async () => {
  assert.deepEqual([1, 2, 3, 4].map(getRetryDelay), [100, 250, 500, null]);
  for (const statusCode of [408, 429, 500, 502, 503, 504]) {
    assert.equal(shouldRetry(statusCode), true, `${statusCode} should retry`);
  }
  for (const statusCode of [200, 201, 400, 401, 403, 404, 409, 422]) {
    assert.equal(shouldRetry(statusCode), false, `${statusCode} should not retry`);
  }

  const calls: any[] = [];
  const sleeps: number[] = [];
  const provider = {
    responses: [
      { ok: false, statusCode: 408 },
      { ok: false, statusCode: 502 },
      { ok: false, statusCode: 504 },
      { ok: true, statusCode: 200 },
    ],
    async authorize(request: any) {
      calls.push(request);
      return this.responses.shift();
    },
    async sleep(delayMs: number) {
      sleeps.push(delayMs);
    },
  };

  const result = await authorizeCheckout({
    provider,
    cardToken: "tok_hidden",
    amount: 4242,
    idempotencyKey: "hidden-key",
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [100, 250, 500]);
  assert.deepEqual(
    calls.map((call) => call.headers["Idempotency-Key"]),
    ["hidden-key", "hidden-key", "hidden-key", "hidden-key"],
  );

  const conflictCalls: any[] = [];
  const conflictProvider = {
    async authorize(request: any) {
      conflictCalls.push(request);
      return { ok: false, statusCode: 409 };
    },
  };
  const conflictResult = await authorizeCheckout({
    provider: conflictProvider,
    cardToken: "tok_conflict",
    amount: 100,
    idempotencyKey: "conflict-key",
  });
  assert.equal(conflictResult.ok, false);
  assert.equal(conflictCalls.length, 1);
});

test("implementation updates shared retry helper rather than checkout wrapper only", async () => {
  const retrySource = await readFile(join(process.cwd(), "src", "retry.js"), "utf8");
  assert.match(retrySource, /408/);
  assert.match(retrySource, /429/);
  assert.match(retrySource, /502/);
  assert.match(retrySource, /504/);
  assert.doesNotMatch(retrySource, /\[50,\s*150,\s*300\]/);
});
