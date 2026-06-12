import { ownerForReleaseGate } from "../checkout/owners.js";

export type ReleaseChecklistItem = {
  id: string;
  owner: string;
  required: boolean;
  status: "complete" | "pending" | "blocked";
  evidence: string;
};

export const releaseChecklist: ReleaseChecklistItem[] = [
  {
    id: "rollback-owner",
    owner: ownerForReleaseGate("rollback"),
    required: true,
    status: "complete",
    evidence: "docs/runbook.md#rollback",
  },
  {
    id: "low-rollout-review",
    owner: "payments-platform",
    required: true,
    status: "pending",
    evidence: "src/checkout/retry-budget.ts",
  },
  {
    id: "smoke-page",
    owner: ownerForReleaseGate("smoke"),
    required: true,
    status: "complete",
    evidence: "web/index.html",
  },
  {
    id: "dependency-docs",
    owner: ownerForReleaseGate("docs"),
    required: false,
    status: "pending",
    evidence: "docs/dependency-upgrade.md",
  },
];
