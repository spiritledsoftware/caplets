import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultTelemetryStateDir } from "../config/paths";
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

export type CodeModeCliOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  configPath?: string | undefined;
  projectConfigPath?: string | undefined;
  authDir?: string | undefined;
  telemetryStateDir?: string | undefined;
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
    telemetryEnv: options.env as NodeJS.ProcessEnv | undefined,
    telemetryStateDir: options.telemetryStateDir ?? defaultTelemetryStateDir(options.env),
    telemetrySurface: "code_mode",
    telemetryVisibility: "visible",
    telemetryRuntimeMode: runtimeScope(options.env) === "local" ? "local" : "unknown",
  });
  try {
    if (options.sessionId !== undefined) {
      const result: CodeModeRunEnvelope = {
        ok: false,
        error: {
          code: "SESSION_NOT_FOUND",
          message:
            "Code Mode one-shot CLI runs do not support --session-id. Omit --session-id to start a fresh one-shot run.",
        },
        diagnostics: [],
        logs: { entries: [], truncated: false, stored: false },
        meta: emptyCodeModeRunMeta(),
      };
      if (options.json) {
        options.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        options.writeOut(`${result.error.code}: ${result.error.message}\n`);
      }
      options.setExitCode(1);
      return;
    }
    const initialProjection = service.reload();
    const code = await readCodeModeCliCode(options);
    await initialProjection;
    const started = Date.now();
    const result = await runCodeMode({
      code,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      service: service.codeModeService?.() ?? service,
      runtimeScope: "cli-one-shot",
    });
    await service
      .captureCodeModeOutcome?.(result, {
        started,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      .catch(() => undefined);
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
    | "telemetryStateDir"
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
    | "env"
    | "configPath"
    | "projectConfigPath"
    | "authDir"
    | "telemetryStateDir"
    | "json"
    | "writeOut"
  >,
): Promise<void> {
  const engine = await CapletsEngine.create({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
    ...(options.authDir ? { authDir: options.authDir } : {}),
    telemetryStateDir: options.telemetryStateDir ?? defaultTelemetryStateDir(options.env),
  });
  try {
    const caplets = await listCodeModeCallableCaplets(engine);
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

async function listCodeModeCallableCaplets(
  engine: CapletsEngine,
): Promise<CodeModeCallableCaplet[]> {
  const { projection } = await engine.exposureProjection({
    discoverNonDirectMcpSurfaces: false,
  });
  return projection.entries
    .flatMap((entry) => {
      if (entry.kind !== "code-mode-caplet") return [];
      return [
        {
          id: entry.id,
          ...(entry.sourceCapletId ? { sourceCapletId: entry.sourceCapletId } : {}),
          name: entry.title ?? entry.id,
          description: entry.description ?? "",
          shadowing: entry.shadowing,
        },
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
