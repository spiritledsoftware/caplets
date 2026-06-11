import { retryBudgetRolloutSummary } from "./retry-budget.js";

export const checkoutStatusPanel = {
  page: "web/index.html",
  heading: "Checkout Status",
  recommendation: "hold",
  reasons: [
    "Rollback owner and low-rollout enabled flag must be verified.",
    "The checkout status panel must render before production rollout.",
  ],
};

export function renderStatusPanelModel() {
  return {
    ...checkoutStatusPanel,
    retryBudget: retryBudgetRolloutSummary(),
  };
}
