import assert from "node:assert/strict";
import test from "node:test";

import { authorizeCheckout } from "../src/checkout-authorization.js";
import { getRetryDelay, shouldRetry } from "../src/retry.js";

test("returns failed provider responses", async () => {
  const provider = {
    calls: [],
    async authorize(request) {
      this.calls.push(request);
      return { ok: false, statusCode: 400 };
    },
  };

  const result = await authorizeCheckout({ provider, cardToken: "tok", amount: 1000 });

  assert.equal(result.ok, false);
  assert.equal(provider.calls.length, 1);
});

test("retries transient authorization failures with documented delays and one idempotency key", async () => {
  const sleeps = [];
  const provider = {
    calls: [],
    responses: [
      { ok: false, statusCode: 500 },
      { ok: false, statusCode: 503 },
      { ok: true, statusCode: 200 },
    ],
    async authorize(request) {
      this.calls.push(request);
      return this.responses.shift();
    },
    async sleep(delayMs) {
      sleeps.push(delayMs);
    },
  };

  const result = await authorizeCheckout({
    provider,
    cardToken: "tok_card",
    amount: 1999,
    idempotencyKey: "auth-key-1",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sleeps, [100, 250]);
  assert.equal(provider.calls.length, 3);
  assert.deepEqual(
    provider.calls.map((call) => call.headers["Idempotency-Key"]),
    ["auth-key-1", "auth-key-1", "auth-key-1"],
  );
});

test("does not retry 409 conflict or other non-retryable authorization statuses", async () => {
  for (const statusCode of [400, 401, 403, 404, 409, 422]) {
    const provider = {
      calls: [],
      async authorize(request) {
        this.calls.push(request);
        return { ok: false, statusCode };
      },
    };

    const result = await authorizeCheckout({ provider, cardToken: "tok", amount: 500 });

    assert.equal(result.ok, false, `${statusCode} should fail`);
    assert.equal(provider.calls.length, 1, `${statusCode} must not retry`);
  }
});

test("shared retry helper matches checkout runbook and API contract", () => {
  assert.deepEqual([1, 2, 3, 4].map(getRetryDelay), [100, 250, 500, null]);
  for (const statusCode of [408, 429, 500, 502, 503, 504]) {
    assert.equal(shouldRetry(statusCode), true, `${statusCode} should retry`);
  }
  for (const statusCode of [400, 401, 403, 404, 409, 422]) {
    assert.equal(shouldRetry(statusCode), false, `${statusCode} should not retry`);
  }
});
