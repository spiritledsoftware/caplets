import { performance } from "node:perf_hooks";
import { runProcess as defaultRunProcess } from "../live-agent";

export type SemanticJudgeInput = {
  task: any;
  finalAnswer: any;
  toolEvidence: any[];
};

export type SemanticJudgeResult = {
  success: boolean;
  score: number;
  missing: string[];
  incorrect: string[];
  reason: string;
  model?: string | null;
  durationMs?: number;
  usage?: Record<string, unknown> | null;
  command?: string;
  args?: string[];
};

export type SemanticJudge = (input: SemanticJudgeInput) => Promise<SemanticJudgeResult>;

export function createPiSemanticJudge({
  piCommand = "pi",
  model,
  env = process.env,
  timeoutMs = 120_000,
  processRunner = defaultRunProcess,
}: {
  piCommand?: string;
  model: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  timeoutMs?: number;
  processRunner?: typeof defaultRunProcess;
}): SemanticJudge {
  if (!model) throw new TypeError("createPiSemanticJudge requires model.");
  return async ({ task, finalAnswer, toolEvidence }) => {
    const startedAt = performance.now();
    const command = buildPiJudgeCommand({
      command: piCommand,
      model,
      prompt: buildJudgePrompt({ task, finalAnswer, toolEvidence }),
    });
    const result = await processRunner({
      command: command.command,
      args: command.args,
      env,
      timeoutMs,
    });

    if (result.timedOut || result.signal || (result.exitCode != null && result.exitCode !== 0)) {
      throw new Error(
        `Semantic judge failed${result.timedOut ? " (timed out)" : ""}${result.exitCode != null ? ` with exit code ${result.exitCode}` : ""}.`,
      );
    }

    const parsed = extractJudgeJson(result.jsonEvents, result.stdout);
    return {
      success: Boolean(parsed.correct) && numberValue(parsed.score) >= 1,
      score: numberValue(parsed.score),
      missing: stringArray(parsed.missing),
      incorrect: stringArray(parsed.incorrect),
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      model,
      durationMs: Math.round(performance.now() - startedAt),
      usage: mergeJudgeUsage(result.jsonEvents),
      command: command.command,
      args: command.args,
    };
  };
}

export function createDeterministicSemanticJudge(
  result: Partial<SemanticJudgeResult> = {},
): SemanticJudge {
  return async () => ({
    success: result.success ?? true,
    score: result.score ?? 1,
    missing: result.missing ?? [],
    incorrect: result.incorrect ?? [],
    reason: result.reason ?? "deterministic semantic judge",
    model: result.model ?? "deterministic-fallback",
    durationMs: result.durationMs ?? 0,
    usage: result.usage ?? null,
  });
}

function buildPiJudgeCommand({
  command,
  model,
  prompt,
}: {
  command: string;
  model: string;
  prompt: string;
}) {
  return {
    command,
    args: [
      "--mode",
      "json",
      "-p",
      prompt,
      "--approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--model",
      model,
    ],
  };
}

function buildJudgePrompt({ task, finalAnswer, toolEvidence }: SemanticJudgeInput) {
  return [
    "You are the semantic judge for an MCP tool-use benchmark.",
    "Return only one JSON object with keys: correct, score, missing, incorrect, reason.",
    "Use score 1 for fully correct and 0 for incorrect.",
    "Judge semantic correctness, not exact JSON shape or field names.",
    "A correct answer may group facts differently if it contains the required information.",
    "Grade required facts and listed distractorFacts first; do not fail an otherwise correct answer for extra non-conflicting details.",
    "When observed tool evidence only exposes an aggregate tool such as caplets_code_mode or executor_execute, use the final-answer evidence citations as granular grounding unless they contradict the answer.",
    "Do not credit unsupported guesses. Use the observed tool evidence to decide whether the answer is grounded.",
    "",
    JSON.stringify({
      task: {
        id: task.id,
        description: task.task_description ?? task.prompt,
        expectedFacts: task.expectedFacts ?? {},
        distractorFacts: task.distractorFacts ?? [],
      },
      finalAnswer,
      observedToolEvidence: toolEvidence,
    }),
  ].join("\n");
}

function extractJudgeJson(events: any[] = [], stdout = "") {
  for (const candidate of [stdout, ...assistantTexts(events)].filter(Boolean).reverse()) {
    const parsed = parseJsonObject(candidate);
    if (parsed) return parsed;
  }
  return {};
}

function assistantTexts(events: any[]) {
  return events.flatMap((event) => {
    const message = event?.message;
    if (message?.role !== "assistant") return [];
    const content = message.content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.map((part: any) => part?.text ?? "").filter(Boolean);
  });
}

function parseJsonObject(value: string) {
  const trimmed = String(value ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/u)?.[1];
  for (const candidate of [fenced, trimmed, trimmed.match(/\{[\s\S]*\}/u)?.[0]].filter(Boolean)) {
    try {
      const parsed = JSON.parse(candidate as string);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function mergeJudgeUsage(events: any[] = []) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  let found = false;
  for (const event of events) {
    const value = event?.message?.usage ?? event?.usage;
    if (!value || typeof value !== "object") continue;
    found = true;
    usage.inputTokens += numberValue(value.inputTokens ?? value.input_tokens ?? value.input);
    usage.outputTokens += numberValue(value.outputTokens ?? value.output_tokens ?? value.output);
    usage.cacheReadTokens += numberValue(
      value.cacheReadTokens ?? value.cache_read_tokens ?? value.cacheRead,
    );
    usage.cacheWriteTokens += numberValue(
      value.cacheWriteTokens ?? value.cache_write_tokens ?? value.cacheWrite,
    );
    usage.totalTokens += numberValue(value.totalTokens ?? value.total_tokens);
  }
  return found ? usage : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
