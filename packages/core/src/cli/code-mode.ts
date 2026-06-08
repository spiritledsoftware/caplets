import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createNativeCapletsService } from "../native/service";
import { codeModeDeclarationHash, generateCodeModeDeclarations } from "../code-mode/declarations";
import { CodeModeLogStore } from "../code-mode/logs";
import { runCodeMode } from "../code-mode/runner";
import { listCodeModeCallableCaplets } from "../code-mode/api";
import type { CodeModeTypesJson } from "../code-mode/types";

export type CodeModeCliOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  configPath?: string | undefined;
  projectConfigPath?: string | undefined;
  authDir?: string | undefined;
  inlineCode?: string | undefined;
  file?: string | undefined;
  timeoutMs?: number | undefined;
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
      service,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      logStore: new CodeModeLogStore(),
      runtimeScope: runtimeScope(options.env),
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

export async function codeModeTypesCli(
  options: Pick<
    CodeModeCliOptions,
    "env" | "configPath" | "projectConfigPath" | "authDir" | "json" | "writeOut"
  >,
): Promise<void> {
  const service = createNativeCapletsService({
    mode: "local",
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
    ...(options.authDir ? { authDir: options.authDir } : {}),
  });
  try {
    const caplets = listCodeModeCallableCaplets(service);
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
    await service.close();
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
