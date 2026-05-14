import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const discountModuleUrl = pathToFileURL(join(process.cwd(), "src", "discount.js"));
const { calculateDiscount } = await import(discountModuleUrl);

test("validates complete discount policy", () => {
  assert.equal(calculateDiscount(100, { tier: "premium" }), 15);
  assert.equal(calculateDiscount(175.55, { tier: "premium" }), 26.33);
  assert.equal(calculateDiscount(99.99, { tier: "premium" }), 0);
  assert.equal(calculateDiscount(20.02, { tier: "employee" }), 5.01);
  assert.equal(calculateDiscount(120, { tier: "employee" }), 30);
  assert.equal(calculateDiscount(200, { tier: "standard" }), 0);
  assert.equal(calculateDiscount(200), 0);
});
