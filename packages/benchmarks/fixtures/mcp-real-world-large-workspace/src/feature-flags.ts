import { retryBudgetPolicy } from "./checkout/retry-budget.js";

export type ReleaseFlag = {
  key: string;
  defaultState: "enabled" | "disabled";
  owner: string;
  rolloutPercent: number;
  rollback: string;
};

export const releaseFlags: ReleaseFlag[] = [
  {
    key: retryBudgetPolicy.flagKey,
    defaultState: "enabled",
    owner: "payments-platform",
    rolloutPercent: retryBudgetPolicy.currentRolloutPercent,
    rollback: "Set checkout.retryBudget.v2 to disabled and restore retryBudget.legacy.",
  },
  {
    key: "pricing.experiment.matrix",
    defaultState: "disabled",
    owner: "growth",
    rolloutPercent: 0,
    rollback: "Remove experiment assignment and serve baseline pricing.",
  },
];

export function riskyEnabledFlags(flags = releaseFlags) {
  return flags.filter(
    (flag) =>
      flag.defaultState === "enabled" &&
      flag.rolloutPercent < retryBudgetPolicy.minimumSafeRolloutPercent,
  );
}
