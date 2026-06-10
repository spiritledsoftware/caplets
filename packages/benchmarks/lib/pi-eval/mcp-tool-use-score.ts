import { toolNameFromEvent } from "./metrics";

export function extractMcpToolUseFinalJson(events: any[] = [], stdout = "") {
  const candidates = [stdout, ...assistantTexts(events)].filter(Boolean);
  for (const candidate of candidates.reverse()) {
    const parsed = parseJsonObject(candidate);
    if (parsed) return parsed;
  }
  return null;
}

export async function scoreMcpToolUseRun({ task, agentResult }: any = {}) {
  if (!task) throw new TypeError("scoreMcpToolUseRun requires a task.");
  const processFailureReason = agentProcessFailureReason(agentResult);
  const processSuccess = !processFailureReason;
  const parsed = extractMcpToolUseFinalJson(
    agentResult?.jsonEvents ?? [],
    agentResult?.stdout ?? "",
  );
  const validation = validateMcpToolUseAnswer({
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
    if (!observedTools.has(expectedTool) && !evidenceText.includes(expectedTool)) {
      failures.push(`missing expected tool evidence: ${expectedTool}`);
    }
  }

  return {
    success: failures.length === 0,
    command: "mcp-tool-use-final-answer-validator",
    args: [task.id],
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
  };
}

function answerContainsExpectedFact(parsed: any, key: string, expected: unknown) {
  if (deepEqual(parsed?.[key], expected)) return true;
  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  return facts.some((fact: any) => fact?.key === key && deepEqual(fact.value, expected));
}

function answerContainsDistractor(parsed: any, distractor: string) {
  if (distractor === "go") return parsed?.decision === "go";
  return JSON.stringify(parsed).includes(String(distractor));
}

function toolEvidenceText(parsed: any) {
  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  return JSON.stringify(facts.flatMap((fact: any) => fact?.evidence ?? []));
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
