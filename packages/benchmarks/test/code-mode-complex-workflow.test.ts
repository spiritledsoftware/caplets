import { describe, expect, it } from "vitest";
import {
  CODE_MODE_COMPLEX_WORKFLOW_THRESHOLDS,
  computeCodeModeComplexWorkflowEval,
  computeCodeModeRepeatedWorkflowEval,
  validateCodeModeComplexWorkflowEval,
  validateCodeModeRepeatedWorkflowEval,
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

  it("captures repeated-workflow session reuse without deterministic live claims", () => {
    const result = computeCodeModeRepeatedWorkflowEval();
    const codeMode = result.strategies.find((strategy) => strategy.strategy === "code-mode")!;
    const progressive = result.strategies.find(
      (strategy) => strategy.strategy === "progressive-disclosure",
    )!;

    expect(validateCodeModeRepeatedWorkflowEval(result)).toEqual([]);
    expect(result.task.id).toBe("repeated-release-gates");
    expect(codeMode.taskSuccess).toBe(true);
    expect(progressive.taskSuccess).toBe(true);
    expect(codeMode.setupCodeEstimatedTokens).toBeLessThan(progressive.setupCodeEstimatedTokens);
    expect(codeMode.providerRequests).toBeLessThan(progressive.providerRequests);
    expect(codeMode.setupCodeReuseRate).toBeGreaterThan(0);
    expect(result.reductions.setupCodeTokens).toBeGreaterThanOrEqual(
      CODE_MODE_COMPLEX_WORKFLOW_THRESHOLDS.minRepeatedSetupTokenReduction,
    );
    expect(result.reductions.providerRequests).toBeGreaterThanOrEqual(
      CODE_MODE_COMPLEX_WORKFLOW_THRESHOLDS.minRepeatedProviderRequestReduction,
    );
    expect(result.reductions.toolCalls).toBeGreaterThanOrEqual(
      CODE_MODE_COMPLEX_WORKFLOW_THRESHOLDS.minRepeatedToolCallReduction,
    );
    expect(result.reductions.requestOverheadTokenProxy).toBeGreaterThanOrEqual(
      CODE_MODE_COMPLEX_WORKFLOW_THRESHOLDS.minRepeatedRequestOverheadReduction,
    );
    expect(result.reductions.elapsedMs).toBeGreaterThanOrEqual(
      CODE_MODE_COMPLEX_WORKFLOW_THRESHOLDS.minRepeatedElapsedTimeReduction,
    );
    expect(result.claim).toContain("deterministic metric shape");
  });

  it("fails repeated-workflow validation when claimed dimensions regress", () => {
    const result = computeCodeModeRepeatedWorkflowEval();
    result.reductions.toolCalls = 0;
    result.reductions.requestOverheadTokenProxy = 0;
    result.reductions.elapsedMs = 0;

    expect(validateCodeModeRepeatedWorkflowEval(result)).toEqual(
      expect.arrayContaining([
        "Repeated workflow tool-call reduction is below threshold.",
        "Repeated workflow request-overhead proxy reduction is below threshold.",
        "Repeated workflow elapsed-time reduction is below threshold.",
      ]),
    );
  });
});
