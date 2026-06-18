import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createNativeCapletsService } from "../native/service";
import { codeModeDeclarationHash, generateCodeModeDeclarations } from "../code-mode/declarations";
import { runCodeMode } from "../code-mode/runner";
import { emptyCodeModeRunMeta } from "../code-mode/tool";
import type {
  CodeModeCallableCaplet,
  CodeModeRunEnvelope,
  CodeModeTypesJson,
} from "../code-mode/types";
import { CapletsEngine } from "../engine";
import { resolveExposure } from "../exposure/policy";

export type CodeModeCliOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  configPath?: string | undefined;
  projectConfigPath?: string | undefined;
  authDir?: string | undefined;
  inlineCode?: string | undefined;
  file?: string | undefined;
  timeoutMs?: number | undefined;
  sessionId?: string | undefined;
  recoveryRef?: string | undefined;
  json?: boolean | undefined;
  readStdin?: (() => Promise<string>) | undefined;
  writeOut: (value: string) => void;
  setExitCode: (code: number) => void;
};

export async function runCodeModeCli(options: CodeModeCliOptions): Promise<void> {
  const service = createNativeCapletsService({
    mode: "local",
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
    ...(options.authDir ? { authDir: options.authDir } : {}),
  });
  try {
    const code = await readCodeModeCliCode(options);
    const result = await runCodeMode({
      code,
      service: service.codeModeService?.() ?? service,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      runtimeScope: "cli-one-shot",
    });
    if (options.json) {
      options.writeOut(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.ok) {
      options.writeOut(`${formatHumanValue(result.value)}\n`);
    } else {
      options.writeOut(`${result.error.code}: ${result.error.message}\n`);
      if (result.diagnostics.length > 0) {
        options.writeOut(
          `${result.diagnostics.map((diagnostic) => `- ${diagnostic.message}`).join("\n")}\n`,
        );
      }
    }
    if (!result.ok) {
      options.setExitCode(1);
    }
  } finally {
    await service.close();
  }
}

export async function runCodeModeReplCli(
  options: Pick<
    CodeModeCliOptions,
    | "env"
    | "configPath"
    | "projectConfigPath"
    | "authDir"
    | "sessionId"
    | "recoveryRef"
    | "json"
    | "writeOut"
    | "setExitCode"
  >,
): Promise<void> {
  const envelope: CodeModeRunEnvelope = {
    ok: false,
    error: {
      code: "UNSUPPORTED_OPERATION",
      message:
        "Code Mode REPL sessions are not available in this build. Use `caplets code-mode` for one-shot runs.",
    },
    diagnostics: [],
    logs: { entries: [], truncated: false, stored: false },
    meta: emptyCodeModeRunMeta(),
  };
  if (options.json) {
    options.writeOut(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    options.writeOut(`${envelope.error.code}: ${envelope.error.message}\n`);
  }
  options.setExitCode(1);
}

export async function codeModeTypesCli(
  options: Pick<
    CodeModeCliOptions,
    "env" | "configPath" | "projectConfigPath" | "authDir" | "json" | "writeOut"
  >,
): Promise<void> {
  const engine = new CapletsEngine({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
    ...(options.authDir ? { authDir: options.authDir } : {}),
  });
  try {
    const caplets = listCodeModeCallableCaplets(engine);
    const declaration = generateCodeModeDeclarations({ caplets });
    if (!options.json) {
      options.writeOut(declaration);
      return;
    }
    const output: CodeModeTypesJson = {
      declaration,
      declarationHash: codeModeDeclarationHash(declaration),
      callableCount: caplets.length,
      generatedAt: new Date().toISOString(),
      runtimeScope: runtimeScope(options.env),
    };
    options.writeOut(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await engine.close();
  }
}

export async function readCodeModeCliCode(
  options: Pick<CodeModeCliOptions, "inlineCode" | "file" | "readStdin">,
): Promise<string> {
  if (options.inlineCode !== undefined) {
    return options.inlineCode;
  }
  if (options.file !== undefined) {
    return readFileSync(resolve(process.cwd(), options.file), "utf8");
  }
  return await (options.readStdin ?? readProcessStdin)();
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function formatHumanValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function runtimeScope(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  return env.CAPLETS_MODE?.trim() || "local";
}

function listCodeModeCallableCaplets(engine: CapletsEngine): CodeModeCallableCaplet[] {
  const defaultExposure = engine.currentConfig().options.exposure;
  return engine
    .enabledServers()
    .filter((caplet) => {
      if (caplet.setup || caplet.projectBinding?.required) return false;
      return resolveExposure(caplet.exposure, defaultExposure).codeMode;
    })
    .map((caplet) => ({
      id: caplet.server,
      name: caplet.name,
      description: caplet.description,
      ...(caplet.useWhen ? { useWhen: caplet.useWhen } : {}),
      ...(caplet.avoidWhen ? { avoidWhen: caplet.avoidWhen } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
