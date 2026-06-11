import { checkoutSmokeStatus } from "./observability/smoke.js";
import { releaseChecklist } from "./release/checklist.js";
import { riskyEnabledFlags } from "./feature-flags.js";

export type ReleaseSignal = {
  source: "ci" | "github" | "runbook" | "browser" | "docs";
  severity: "low" | "medium" | "high";
  summary: string;
};

export function classifyReleaseRisk(signals: ReleaseSignal[]) {
  const highSignals = signals.filter((signal) => signal.severity === "high");
  const riskyFlags = riskyEnabledFlags();
  const incompleteRequiredChecks = releaseChecklist.filter(
    (item) => item.required && item.status !== "complete",
  );
  if (
    highSignals.length > 0 ||
    riskyFlags.length > 0 ||
    checkoutSmokeStatus.panelLoaded !== true ||
    incompleteRequiredChecks.length > 0
  ) {
    return {
      decision: "hold",
      reasons: [
        ...highSignals.map((signal) => signal.summary),
        ...riskyFlags.map((flag) => `${flag.key} is enabled below 50% rollout`),
        ...incompleteRequiredChecks.map((item) => `${item.id} is ${item.status}`),
        ...(checkoutSmokeStatus.panelLoaded ? [] : ["Checkout status panel is not verified"]),
      ],
    };
  }
  return {
    decision: "ship",
    reasons: ["No high severity signals, risky enabled flags, or incomplete required checks."],
  };
}

export function summarizeReleaseGate(signals = currentReleaseSignals) {
  const risk = classifyReleaseRisk(signals);
  return {
    decision: risk.decision,
    owner: releaseChecklist.find((item) => item.id === "rollback-owner")?.owner,
    smokePage: checkoutSmokeStatus.page,
    reasons: risk.reasons,
  };
}

export const currentReleaseSignals: ReleaseSignal[] = [
  {
    source: "runbook",
    severity: "high",
    summary: "Rollback owner must be assigned before production rollout.",
  },
  {
    source: "docs",
    severity: "medium",
    summary: "React migration notes changed since the last release checklist update.",
  },
  {
    source: "browser",
    severity: checkoutSmokeStatus.panelLoaded ? "low" : "high",
    summary: checkoutSmokeStatus.summary,
  },
];
