export const retryBudgetPolicy = {
  flagKey: "checkout.retryBudget.v2",
  legacyFallbackKey: "retryBudget.legacy",
  minimumSafeRolloutPercent: 50,
  currentRolloutPercent: 25,
  owner: "payments-platform",
  rolloutChannel: "checkout-release",
};

export function retryBudgetRolloutSummary() {
  return {
    key: retryBudgetPolicy.flagKey,
    safe: retryBudgetPolicy.currentRolloutPercent >= retryBudgetPolicy.minimumSafeRolloutPercent,
    currentRolloutPercent: retryBudgetPolicy.currentRolloutPercent,
    minimumSafeRolloutPercent: retryBudgetPolicy.minimumSafeRolloutPercent,
  };
}
