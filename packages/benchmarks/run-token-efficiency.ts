#!/usr/bin/env node
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";
import {
  createNativeCapletsService,
  nativeCapletsSystemGuidance,
  type NativeCapletTool,
  type NativeCapletsService,
} from "@caplets/core/native";
import { createPiEvalRunConfig } from "./lib/pi-eval/config";

type CodeModeEnvelope = {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly meta?: {
    readonly sessionId?: string;
  };
};

type WorkloadCall = {
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: CodeModeEnvelope;
};

const encoding = getEncoding("cl100k_base");
const runRoot = await mkdtemp(join(tmpdir(), "caplets-token-efficiency-"));
const sourceAgentDir = join(runRoot, "source-agent");
const previousPath = process.env.PATH;

try {
  await mkdir(sourceAgentDir, { recursive: true });
  const config = await createPiEvalRunConfig({
    rootDir: runRoot,
    mode: "caplets-code-mode",
    piAgentSourceDir: sourceAgentDir,
  });
  process.env.PATH = config.env.PATH;

  const service = createNativeCapletsService({
    mode: "local",
    configPath: config.configPath,
    watch: false,
  });

  try {
    if (!(await service.reload())) {
      throw new Error("The deterministic Caplets fixture failed to load.");
    }

    const codeModeTool = findCodeModeTool(service.listTools());
    const calls: WorkloadCall[] = [];

    await recordCall(
      service,
      calls,
      `
        const [incidents, run, guidance, files] = await Promise.all([
          caplets.issues.callTool("active_incidents", {}),
          caplets.ci.callTool("get_run", { id: "ci-4821" }),
          caplets.docs.callTool("idempotency_guidance", {}),
          caplets["code-map"].callTool("target_files", { id: "checkout" }),
        ]);
        return { incidents, run, guidance, files };
      `,
    );

    await recordCall(
      service,
      calls,
      `
        const [issues, docs, code] = await Promise.all([
          caplets.issues.searchTools("incident"),
          caplets.docs.searchTools("idempotency"),
          caplets["code-map"].searchTools("checkout"),
        ]);
        return { issues, docs, code };
      `,
    );

    const sessionStart = await recordCall(
      service,
      calls,
      `
        async function loadReleaseContext() {
          return await Promise.all([
            caplets.issues.callTool("active_incidents", {}),
            caplets.docs.callTool("idempotency_guidance", {}),
          ]);
        }
        return await loadReleaseContext();
      `,
    );
    const sessionId = sessionStart.meta?.sessionId;
    if (!sessionId) {
      throw new Error("The reusable Code Mode session did not return a session ID.");
    }

    await recordCall(service, calls, "return await loadReleaseContext();", sessionId);

    const successfulCalls = calls.filter((call) => call.output.ok).length;
    const successRate = successfulCalls / calls.length;
    if (successRate !== 1) {
      throw new Error(`Deterministic workload success rate was ${successRate}.`);
    }

    const surfaceTokens = countTokens({
      name: codeModeTool.toolName,
      title: codeModeTool.title,
      description: codeModeTool.description,
      promptGuidance: codeModeTool.promptGuidance,
      inputSchema: codeModeTool.inputSchema,
      systemGuidance: nativeCapletsSystemGuidance([codeModeTool.toolName]),
    });
    const workflowTokens = calls.reduce(
      (total, call) =>
        total +
        countTokens({
          input: call.input,
          output: stableAgentOutput(call.output),
        }),
      0,
    );
    const tokenBurden = surfaceTokens * calls.length + workflowTokens;

    console.log(`METRIC token_burden=${tokenBurden}`);
    console.log(`METRIC success_rate=${successRate}`);
    console.log(`METRIC surface_tokens=${surfaceTokens}`);
    console.log(`METRIC workflow_tokens=${workflowTokens}`);
    console.log(`METRIC workload_calls=${calls.length}`);
  } finally {
    await service.close();
  }
} finally {
  process.env.PATH = previousPath;
  await rm(runRoot, { recursive: true, force: true });
}

async function recordCall(
  service: NativeCapletsService,
  calls: WorkloadCall[],
  code: string,
  sessionId?: string,
): Promise<CodeModeEnvelope> {
  const input = sessionId ? { code: code.trim(), sessionId } : { code: code.trim() };
  const output = parseCodeModeEnvelope(await service.execute("code_mode", input));
  calls.push({ input, output });
  return output;
}

function findCodeModeTool(tools: readonly NativeCapletTool[]): NativeCapletTool {
  const tool = tools.find((candidate) => candidate.toolName === "caplets__code_mode");
  if (!tool) {
    throw new Error("The deterministic fixture did not expose Code Mode.");
  }
  return tool;
}

function parseCodeModeEnvelope(input: unknown): CodeModeEnvelope {
  if (!isRecord(input) || typeof input.ok !== "boolean") {
    throw new Error("Code Mode returned an invalid envelope.");
  }
  const sessionId =
    isRecord(input.meta) && typeof input.meta.sessionId === "string"
      ? input.meta.sessionId
      : undefined;
  return {
    ok: input.ok,
    ...("value" in input ? { value: input.value } : {}),
    ...(sessionId ? { meta: { sessionId } } : {}),
  };
}

function stableAgentOutput(envelope: CodeModeEnvelope): Readonly<Record<string, unknown>> {
  return {
    ok: envelope.ok,
    value: stableValue(envelope.value),
    sessionReusable: Boolean(envelope.meta?.sessionId),
  };
}

function stableValue(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(stableValue);
  }
  if (!isRecord(input)) {
    return input;
  }
  return Object.fromEntries(
    Object.entries(input)
      .filter(
        ([key]) => !["durationMs", "elapsedMs", "runId", "sessionId", "traceId"].includes(key),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, stableValue(value)]),
  );
}

function countTokens(input: unknown): number {
  return encoding.encode(JSON.stringify(stableValue(input))).length;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
