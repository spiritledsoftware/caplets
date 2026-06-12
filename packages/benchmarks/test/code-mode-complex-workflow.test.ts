import { describe, expect, it } from "vitest";
import {
  CODE_MODE_COMPLEX_WORKFLOW_THRESHOLDS,
  computeCodeModeComplexWorkflowEval,
  computeCodeModeLiveRegressionEval,
  validateCodeModeComplexWorkflowEval,
  validateCodeModeLiveRegressionEval,
} from "../lib/code-mode";

describe("Code Mode complex workflow eval", () => {
  it("captures the real-world triage workflow regression deterministically", () => {
    const result = computeCodeModeComplexWorkflowEval();
    const codeMode = result.strategies.find((strategy) => strategy.strategy === "code-mode")!;
    const progressive = result.strategies.find(
      (strategy) => strategy.strategy === "progressive-disclosure",
    )!;
    const vanilla = result.strategies.find((strategy) => strategy.strategy === "vanilla-mcp")!;

    expect(validateCodeModeComplexWorkflowEval(result)).toEqual([]);
    expect(codeMode.codeModeRunCalls).toBe(1);
    expect(codeMode.llmRoundTrips).toBe(1);
    expect(codeMode.internalCapletCalls).toBeGreaterThan(1);
    expect(codeMode.externalToolCalls).toBeLessThan(progressive.externalToolCalls);
    expect(codeMode.approxPayloadTokens).toBeLessThan(progressive.approxPayloadTokens);
    expect(codeMode.missingFields).toEqual([]);
    expect(codeMode.rawPayloadLeaked).toBe(false);
    expect(vanilla.missingFields).toEqual(["url", "labels", "created_at"]);
    expect(result.reductions.codeModeVsProgressiveExternalCalls).toBeGreaterThanOrEqual(
      CODE_MODE_COMPLEX_WORKFLOW_THRESHOLDS.minExternalCallReduction,
    );
  });

  it("tracks live cold-agent regressions from OSV and GitHub evals", () => {
    const result = computeCodeModeLiveRegressionEval();

    expect(validateCodeModeLiveRegressionEval(result)).toEqual([]);
    expect(result.scenarios.map((scenario) => scenario.id)).toEqual([
      "github-issues-and-prs-adjacent-entities",
      "osv-package-version-tool-selection",
    ]);
    expect(result.improvements).toContain("code-mode-one-run-guidance");
    expect(result.improvements).toContain("optional-use-avoid-hints");
    expect(result.improvements).toContain("schema-error-call-signatures");
    expect(result.improvements).toContain("transport-body-normalization");
  });
});
