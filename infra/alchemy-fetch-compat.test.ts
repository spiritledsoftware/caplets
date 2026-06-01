import { expect, test } from "vitest";

test("Alchemy fetch compatibility shim removes userland undici dispatcher before native fetch", async () => {
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_input, init = {}) => {
    calls.push(init);
    return new Response("ok");
  };

  await import("./alchemy-fetch-compat.js");

  const response = await globalThis.fetch("https://example.test", {
    dispatcher: { dispatch() {} },
    headers: { "x-test": "1" },
  } as unknown as RequestInit);

  expect(await response.text()).toBe("ok");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toBeDefined();
  expect("dispatcher" in calls[0]!).toBe(false);
  expect(calls[0]!.headers).toEqual({ "x-test": "1" });
});
