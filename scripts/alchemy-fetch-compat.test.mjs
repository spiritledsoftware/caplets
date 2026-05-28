import assert from "node:assert/strict";
import { test } from "node:test";

test("Alchemy fetch compatibility shim removes userland undici dispatcher before native fetch", async () => {
  const calls = [];
  globalThis.fetch = async (_input, init = {}) => {
    calls.push(init);
    return new Response("ok");
  };

  await import(`./alchemy-fetch-compat.mjs?cache-bust=${Date.now()}`);

  const response = await globalThis.fetch("https://example.test", {
    dispatcher: { dispatch() {} },
    headers: { "x-test": "1" },
  });

  assert.equal(await response.text(), "ok");
  assert.equal(calls.length, 1);
  assert.equal("dispatcher" in calls[0], false);
  assert.deepEqual(calls[0].headers, { "x-test": "1" });
});
