export const checkoutOwners = {
  product: "checkout-platform",
  rollback: "payments-platform",
  observability: "checkout-observability",
  docs: "developer-experience",
};

export function ownerForReleaseGate(gate: "rollback" | "smoke" | "docs") {
  if (gate === "rollback") return checkoutOwners.rollback;
  if (gate === "smoke") return checkoutOwners.observability;
  return checkoutOwners.docs;
}
