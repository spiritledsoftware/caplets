import ts from "typescript";
import { CODE_MODE_DIAGNOSTICS_BUILTINS_DECLARATION } from "./diagnostics-builtins.generated";
import { hasDirectFetchCall, hasExecutableImport } from "./static-analysis";
import type { CodeModeDiagnostic } from "./types";

export type DiagnoseCodeModeTypeScriptInput = {
  code: string;
  declaration: string;
  maxDiagnostics?: number;
  timeoutMs?: number;
  session?: CodeModeDiagnosticsSession;
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

  const compilerOptions = codeModeCompilerOptions();
  const wrappedCode = [
    "async function __capletsCodeModeMain(): Promise<unknown> {",
    input.code,
    "}",
  ].join("\n");
  const host = createVirtualCompilerHost(compilerOptions, {
    [CODE_FILE]: wrappedCode,
    [DECLARATION_FILE]: input.declaration,
    [AMBIENT_FILE]: [
      CODE_MODE_DIAGNOSTICS_BUILTINS_DECLARATION,
      input.session?.declaration() ?? "",
    ].join("\n"),
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

function codeModeCompilerOptions(): ts.CompilerOptions {
  return {
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
}

export class CodeModeDiagnosticsSession {
  #declarations = new Map<string, string>();

  declaration(): string {
    return [...this.#declarations.values()].join("\n");
  }

  recordSuccessfulCell(code: string): void {
    const source = ts.createSourceFile(
      "/caplets-code-mode/session-cell.ts",
      code,
      ts.ScriptTarget.ES2022,
      true,
    );
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const typeParameters = statement.typeParameters
          ? `<${statement.typeParameters.map((typeParameter) => typeParameter.getText(source)).join(", ")}>`
          : "";
        const params = statement.parameters.map((parameter) => ambientParameter(parameter, source));
        const returnType = statement.type ? `: ${statement.type.getText(source)}` : ": unknown";
        this.#declarations.set(
          statement.name.text,
          `declare function ${statement.name.text}${typeParameters}(${params.join(", ")})${returnType};`,
        );
      }
    }
    const compilerOptions = codeModeCompilerOptions();
    const host = createVirtualCompilerHost(compilerOptions, {
      [CODE_FILE]: code,
      [AMBIENT_FILE]: [CODE_MODE_DIAGNOSTICS_BUILTINS_DECLARATION, this.declaration()].join("\n"),
    });
    const program = ts.createProgram([CODE_FILE, AMBIENT_FILE], compilerOptions, host);
    const checker = program.getTypeChecker();
    const programSource = program.getSourceFile(CODE_FILE) ?? source;
    for (const binding of collectFunctionScopedVarBindings(programSource, checker)) {
      this.#declarations.set(binding.name, `declare var ${binding.name}: ${binding.type};`);
    }
  }

  clear(): void {
    this.#declarations.clear();
  }
}

type AmbientVarBinding = {
  name: string;
  type: string;
};

function collectFunctionScopedVarBindings(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): AmbientVarBinding[] {
  const bindings = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (node !== source && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
      return;
    }
    if (ts.isVariableStatement(node)) {
      collectVarDeclarationListBindings(node.declarationList, checker, bindings);
    }
    if (
      (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      collectVarDeclarationListBindings(node.initializer, checker, bindings);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...bindings.entries()].map(([name, type]) => ({ name, type }));
}

function collectVarDeclarationListBindings(
  declarationList: ts.VariableDeclarationList,
  checker: ts.TypeChecker,
  bindings: Map<string, string>,
): void {
  const isVar = (ts.getCombinedNodeFlags(declarationList) & ts.NodeFlags.BlockScoped) === 0;
  if (!isVar) {
    return;
  }
  for (const declaration of declarationList.declarations) {
    for (const name of bindingNames(declaration.name)) {
      const type = ambientTypeForBindingName(name, checker);
      bindings.set(name.text, type);
    }
  }
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return [name];
  }
  return name.elements.flatMap((element) => {
    if (ts.isOmittedExpression(element)) {
      return [];
    }
    return bindingNames(element.name);
  });
}

function ambientTypeForBindingName(name: ts.Identifier, checker: ts.TypeChecker): string {
  const type = checker.getTypeAtLocation(name);
  return safeAmbientType(type, checker);
}

function safeAmbientType(type: ts.Type, checker: ts.TypeChecker): string {
  if (isUnsafeAmbientType(type)) {
    return "unknown";
  }
  const text = checker.typeToString(
    type,
    undefined,
    ts.TypeFormatFlags.NoTruncation |
      ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
      ts.TypeFormatFlags.WriteArrayAsGenericType,
  );
  if (!text || text === "any" || text === "{}" || text === "never") {
    return "unknown";
  }
  if (text.length > 500) {
    return "unknown";
  }
  if (/\bimport\(/u.test(text)) {
    return "unknown";
  }
  return text;
}

function isUnsafeAmbientType(type: ts.Type): boolean {
  return Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never));
}

function ambientParameter(parameter: ts.ParameterDeclaration, source: ts.SourceFile): string {
  const dotDotDot = parameter.dotDotDotToken ? "..." : "";
  const name = parameter.name.getText(source);
  const optional = parameter.questionToken || parameter.initializer ? "?" : "";
  const type =
    parameter.type?.getText(source) ??
    (parameter.initializer ? inferLiteralType(parameter.initializer) : "unknown");
  return `${dotDotDot}${name}${optional}: ${type}`;
}

function inferLiteralType(initializer: ts.Expression | undefined): string {
  if (!initializer) return "unknown";
  if (ts.isNumericLiteral(initializer)) return "number";
  if (ts.isStringLiteral(initializer)) return "string";
  if (
    initializer.kind === ts.SyntaxKind.TrueKeyword ||
    initializer.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return "boolean";
  }
  return "unknown";
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
      message:
        "Direct fetch is not available in Code Mode; use a Caplet instead. Cannot find name 'fetch'.",
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
