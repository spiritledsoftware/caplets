const assert = require("node:assert/strict");
const test = require("node:test");

const { calculateDiscount } = require("../src/discount.js");

test("exports the discount calculator", () => {
  assert.equal(typeof calculateDiscount, "function");
});

test("handles anonymous carts safely", () => {
  assert.equal(calculateDiscount(50), 0);
});

test("does not discount unknown tiers", () => {
  assert.equal(calculateDiscount(50, { tier: "guest" }), 0);
});
