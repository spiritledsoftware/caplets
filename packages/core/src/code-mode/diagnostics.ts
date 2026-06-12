import ts from "typescript";
import { hasDirectFetchCall, hasExecutableImport } from "./static-analysis";
import type { CodeModeDiagnostic } from "./types";

export type DiagnoseCodeModeTypeScriptInput = {
  code: string;
  declaration: string;
  maxDiagnostics?: number;
  timeoutMs?: number;
};

const CODE_FILE = "/caplets-code-mode/input.ts";
const DECLARATION_FILE = "/caplets-code-mode/caplets.d.ts";
const AMBIENT_FILE = "/caplets-code-mode/ambient.d.ts";

const TS_NOCHECK_PATTERN =
  /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*?(?:(?:\/\/\s*@ts-nocheck\b[^\n]*)|(?:\/\*\s*@ts-nocheck\b[\s\S]*?\*\/))/u;
const BAD_CALL_METHOD_PATTERN = /\bcaplets(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\.call\s*\(/u;

export function diagnoseCodeModeTypeScript(
  input: DiagnoseCodeModeTypeScriptInput,
): CodeModeDiagnostic[] {
  const maxDiagnostics = input.maxDiagnostics ?? 50;
  const startedAt = Date.now();
  const preflight = preflightDiagnostics(input.code);
  const diagnostics: CodeModeDiagnostic[] = [...preflight];
  if (diagnostics.length >= maxDiagnostics) {
    return diagnostics.slice(0, maxDiagnostics);
  }

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts"],
    types: [],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    noErrorTruncation: true,
    allowJs: false,
  };
  const wrappedCode = [
    "async function __capletsCodeModeMain(): Promise<unknown> {",
    input.code,
    "}",
  ].join("\n");
  const host = createVirtualCompilerHost(compilerOptions, {
    [CODE_FILE]: wrappedCode,
    [DECLARATION_FILE]: input.declaration,
    [AMBIENT_FILE]: ambientDeclarations(),
  });
  const program = ts.createProgram(
    [CODE_FILE, DECLARATION_FILE, AMBIENT_FILE],
    compilerOptions,
    host,
  );
  const source = program.getSourceFile(CODE_FILE);
  const tsNoCheck = TS_NOCHECK_PATTERN.test(input.code);
  const syntacticDiagnostics = program.getSyntacticDiagnostics(source);
  const semanticDiagnostics = tsNoCheck ? [] : program.getSemanticDiagnostics(source);
  const syntacticDiagnosticSet = new Set<ts.Diagnostic>(syntacticDiagnostics);
  if (tsNoCheck) {
    diagnostics.push({
      code: "ts_nocheck_applied",
      severity: "info",
      message:
        "@ts-nocheck suppressed TypeScript diagnostics; Code Mode safety checks still applied.",
    });
  }
  for (const diagnostic of [...syntacticDiagnostics, ...semanticDiagnostics]) {
    diagnostics.push(formatDiagnostic(diagnostic, syntacticDiagnosticSet.has(diagnostic)));
    if (diagnostics.length >= maxDiagnostics) {
      break;
    }
    if (input.timeoutMs !== undefined && Date.now() - startedAt > input.timeoutMs) {
      diagnostics.push({
        code: "DIAGNOSTIC_TIMEOUT",
        severity: "error",
        message: `Code Mode diagnostics exceeded ${input.timeoutMs}ms.`,
      });
      break;
    }
  }
  return diagnostics.slice(0, maxDiagnostics);
}

function preflightDiagnostics(code: string): CodeModeDiagnostic[] {
  const diagnostics: CodeModeDiagnostic[] = [];
  if (!hasExecutableImport(code)) {
    // continue with other custom checks below
  } else {
    diagnostics.push({
      code: "IMPORT_UNAVAILABLE",
      severity: "error",
      message: "Imports are not available in Code Mode.",
    });
  }
  if (BAD_CALL_METHOD_PATTERN.test(code)) {
    diagnostics.push({
      code: "INVALID_CAPLET_METHOD",
      severity: "error",
      message: "CapletHandle does not expose call(). Use callTool(name, args) for tool calls.",
    });
  }
  if (hasDirectFetchCall(code)) {
    diagnostics.push({
      code: "FETCH_UNAVAILABLE",
      severity: "error",
      message: "Direct fetch is not available in Code Mode; use a Caplet instead.",
    });
  }
  return diagnostics;
}

function createVirtualCompilerHost(
  options: ts.CompilerOptions,
  files: Record<string, string>,
): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  return {
    ...host,
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const source = files[fileName];
      if (source !== undefined) {
        return ts.createSourceFile(fileName, source, languageVersion, true);
      }
      return defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
    fileExists(fileName) {
      return files[fileName] !== undefined || defaultFileExists(fileName);
    },
    readFile(fileName) {
      return files[fileName] ?? defaultReadFile(fileName);
    },
  };
}

function formatDiagnostic(
  diagnostic: ts.Diagnostic,
  syntacticDiagnostic = false,
): CodeModeDiagnostic {
  const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return {
    code: String(diagnostic.code),
    severity:
      syntacticDiagnostic || diagnostic.category === ts.DiagnosticCategory.Warning
        ? diagnostic.category === ts.DiagnosticCategory.Warning
          ? "warning"
          : "error"
        : "warning",
    message:
      diagnostic.code === 2339 && message.includes("Property 'call' does not exist")
        ? `${message} Use callTool(name, args) on CapletHandle.`
        : message,
    ...(position
      ? {
          line: Math.max(1, position.line),
          column: Math.max(1, position.character + 1),
        }
      : {}),
  };
}

function ambientDeclarations(): string {
  return [
    "declare class URL {",
    "  constructor(input: string, base?: string);",
    "  readonly href: string;",
    "  readonly searchParams: URLSearchParams;",
    "  toString(): string;",
    "}",
    "declare class URLSearchParams {",
    "  constructor(init?: string | Record<string, string> | Array<[string, string]>);",
    "  get(name: string): string | null;",
    "  set(name: string, value: string): void;",
    "  has(name: string): boolean;",
    "  toString(): string;",
    "}",
  ].join("\n");
}
