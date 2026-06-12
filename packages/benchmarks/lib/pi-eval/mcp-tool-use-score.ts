import { toolNameFromEvent } from "./metrics";
import type { SemanticJudge } from "./semantic-judge";

export function extractMcpToolUseFinalJson(events: any[] = [], stdout = "") {
  const candidates = [stdout, ...assistantTexts(events)].filter(Boolean);
  for (const candidate of candidates.reverse()) {
    const parsed = parseJsonObject(candidate);
    if (parsed) return parsed;
  }
  return null;
}

export async function scoreMcpToolUseRun({ task, agentResult, semanticJudge }: any = {}) {
  if (!task) throw new TypeError("scoreMcpToolUseRun requires a task.");
  const processFailureReason = agentProcessFailureReason(agentResult);
  const processSuccess = !processFailureReason;
  const parsed = extractMcpToolUseFinalJson(
    agentResult?.jsonEvents ?? [],
    agentResult?.stdout ?? "",
  );
  const validation = semanticJudge
    ? await judgeMcpToolUseAnswer({
        task,
        parsed,
        events: agentResult?.jsonEvents ?? [],
        semanticJudge,
      })
    : validateMcpToolUseAnswer({
        task,
        parsed,
        events: agentResult?.jsonEvents ?? [],
      });
  return {
    taskId: task.id,
    success: processSuccess && validation.success,
    finalStateValid: validation.success,
    processSuccess,
    processFailureReason,
    validation,
    hiddenValidation: { success: true, skipped: true, command: undefined },
    semanticJudge: validation.semanticJudge ?? null,
    process: agentResult
      ? {
          exitCode: agentResult.exitCode,
          signal: agentResult.signal,
          timedOut: agentResult.timedOut,
          durationMs: agentResult.durationMs,
          command: agentResult.command,
          args: agentResult.args,
          envKeys: agentResult.envKeys,
          skipped: agentResult.skipped,
          unavailable: agentResult.unavailable,
          configConflict: agentResult.configConflict,
        }
      : undefined,
    parsedFinalAnswer: parsed,
  };
}

async function judgeMcpToolUseAnswer({
  task,
  parsed,
  events,
  semanticJudge,
}: {
  task: any;
  parsed: any;
  events: any[];
  semanticJudge: SemanticJudge;
}) {
  const failures: string[] = [];
  if (!parsed || typeof parsed !== "object") {
    failures.push("final JSON object was not found");
  } else if (parsed.taskId !== task.id) {
    failures.push(`taskId mismatch: ${String(parsed.taskId)}`);
  }

  if (failures.length > 0) {
    return validationResult({ failures, semanticJudgeResult: null });
  }

  const semanticJudgeResult = await semanticJudge({
    task,
    finalAnswer: parsed,
    toolEvidence: collectToolEvidence({ events, parsed }),
  });
  if (!semanticJudgeResult.success) {
    failures.push(semanticJudgeResult.reason || "semantic judge failed");
    failures.push(...semanticJudgeResult.missing.map((entry) => `missing: ${entry}`));
    failures.push(...semanticJudgeResult.incorrect.map((entry) => `incorrect: ${entry}`));
  }
  return validationResult({ failures, semanticJudgeResult });
}

function validateMcpToolUseAnswer({ task, parsed, events }: any) {
  const failures: string[] = [];
  if (!parsed || typeof parsed !== "object") {
    failures.push("final JSON object was not found");
  } else {
    if (parsed.taskId !== task.id) failures.push(`taskId mismatch: ${String(parsed.taskId)}`);
    for (const [key, expected] of Object.entries(task.expectedFacts ?? {})) {
      if (!answerContainsExpectedFact(parsed, key, expected)) {
        failures.push(`missing expected fact: ${key}`);
      }
    }
    for (const distractor of task.distractorFacts ?? []) {
      if (answerContainsDistractor(parsed, distractor)) {
        failures.push(`distractor fact appeared: ${distractor}`);
      }
    }
  }

  const observedTools = new Set(events.map(toolNameFromEvent).filter(Boolean));
  const evidenceText = toolEvidenceText(parsed);
  for (const expectedTool of task.expectedEvidence?.tools ?? []) {
    if (!hasToolEvidence(expectedTool)) {
      failures.push(`missing expected tool evidence: ${expectedTool}`);
    }
  }
  for (const alternatives of task.expectedEvidence?.anyTools ?? []) {
    if (!alternatives.some((tool: string) => hasToolEvidence(tool))) {
      failures.push(`missing expected tool evidence: one of ${alternatives.join(", ")}`);
    }
  }

  return validationResult({ failures, semanticJudgeResult: null });

  function hasToolEvidence(tool: string) {
    return toolEvidenceAliases(tool).some(
      (alias) => observedTools.has(alias) || evidenceText.includes(alias),
    );
  }
}

function validationResult({ failures, semanticJudgeResult }: any) {
  return {
    success: failures.length === 0,
    command: "mcp-tool-use-final-answer-validator",
    args: [],
    exitCode: failures.length === 0 ? 0 : 1,
    signal: null,
    timedOut: false,
    durationMs: 0,
    stdout: failures.join("\n"),
    stderr: "",
    stdoutBytes: Buffer.byteLength(failures.join("\n"), "utf8"),
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    semanticJudge: semanticJudgeResult,
  };
}

function answerContainsExpectedFact(parsed: any, key: string, expected: unknown) {
  if (deepEqual(parsed?.[key], expected)) return true;
  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  return (
    facts.some((fact: any) => fact?.key === key && deepEqual(fact.value, expected)) ||
    containsExpectedValue(parsed, expected)
  );
}

function answerContainsDistractor(parsed: any, distractor: string) {
  if (distractor === "go") return parsed?.decision === "go";
  return JSON.stringify(parsed).includes(String(distractor));
}

function toolEvidenceText(parsed: any) {
  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  return JSON.stringify(facts.flatMap((fact: any) => evidenceEntries(fact?.evidence)));
}

function evidenceEntries(evidence: any): string[] {
  if (evidence == null) return [];
  if (typeof evidence === "string") return [evidence];
  if (Array.isArray(evidence)) return evidence.flatMap(evidenceEntries);
  if (typeof evidence === "object") {
    const entries = [JSON.stringify(evidence)];
    const server = typeof evidence.server === "string" ? evidence.server : null;
    if (server && typeof evidence.tool === "string") entries.push(`${server}.${evidence.tool}`);
    if (server && Array.isArray(evidence.tools)) {
      entries.push(...evidence.tools.map((tool: string) => `${server}.${tool}`));
    }
    return entries;
  }
  return [String(evidence)];
}

function collectToolEvidence({ events, parsed }: { events: any[]; parsed: any }) {
  return [
    ...events
      .map((event) => toolNameFromEvent(event))
      .filter(Boolean)
      .map((toolName) => ({ source: "event", toolName })),
    ...((Array.isArray(parsed?.facts) ? parsed.facts : []) as any[]).flatMap((fact) =>
      evidenceEntries(fact?.evidence).map((evidence) => ({
        source: "final_answer",
        key: fact?.key,
        evidence,
      })),
    ),
  ];
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

function parseJsonObject(text: string) {
  const trimmed = String(text ?? "").trim();
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

function deepEqual(a: unknown, b: unknown) {
  return JSON.stringify(sortJson(a)) === JSON.stringify(sortJson(b));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson).sort(compareJsonValues);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function compareJsonValues(a: unknown, b: unknown) {
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

function containsExpectedValue(container: unknown, expected: unknown): boolean {
  if (deepEqual(container, expected)) return true;
  if (Array.isArray(container) && derivedArrayContainsExpected(container, expected)) return true;
  if (Array.isArray(container)) {
    return container.some((entry) => containsExpectedValue(entry, expected));
  }
  if (!container || typeof container !== "object") return false;
  return Object.values(container).some((value) => containsExpectedValue(value, expected));
}

function derivedArrayContainsExpected(container: unknown[], expected: unknown) {
  if (typeof expected === "number" && container.length === expected) return true;
  if (isStringArray(expected)) {
    return candidateStringFields(container).some((field) => {
      const values = [
        ...new Set(
          container
            .map((entry) => (isRecord(entry) ? entry[field] : undefined))
            .filter((value): value is string => typeof value === "string"),
        ),
      ].sort();
      return deepEqual(values, expected);
    });
  }
  if (isCountObject(expected)) {
    return candidateStringFields(container).some((field) => {
      const counts: Record<string, number> = {};
      for (const entry of container) {
        if (!isRecord(entry) || typeof entry[field] !== "string") continue;
        counts[entry[field]] = (counts[entry[field]] ?? 0) + 1;
      }
      return deepEqual(counts, expected);
    });
  }
  return false;
}

function candidateStringFields(container: unknown[]) {
  return [
    ...new Set(
      container.flatMap((entry) =>
        isRecord(entry)
          ? Object.entries(entry)
              .filter(([, value]) => typeof value === "string")
              .map(([key]) => key)
          : [],
      ),
    ),
  ];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isCountObject(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every((entry) => typeof entry === "number")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolEvidenceAliases(tool: string) {
  const value = String(tool);
  const aliases = new Set([value]);
  const dot = value.indexOf(".");
  if (dot > 0) {
    const server = value.slice(0, dot);
    const toolName = value.slice(dot + 1);
    aliases.add(toolName);
    aliases.add(`${server}_${toolName}`);
    aliases.add(`${server}__${toolName}`);
    aliases.add(`caplets__${server}__${toolName}`);
  }
  return [...aliases];
}

function agentProcessFailureReason(agentResult: any) {
  if (!agentResult) return "agent result missing";
  if (agentResult.timedOut) return "agent timed out";
  if (agentResult.signal) return `agent exited with signal ${agentResult.signal}`;
  if (agentResult.skipped || agentResult.unavailable) {
    return agentResult.reason ?? "agent unavailable";
  }
  if (agentResult.configConflict) return agentResult.reason ?? "agent config conflict";
  if (agentResult.benchmarkHarnessCapturedError) {
    return agentResult.stderr || "agent runner threw before scoring";
  }
  if (agentResult.exitCode != null && agentResult.exitCode !== 0) {
    return `agent exited with code ${agentResult.exitCode}`;
  }
  return undefined;
}
