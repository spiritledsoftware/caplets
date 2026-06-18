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

  recordSuccessfulCell(code: string, declaration = ""): void {
    const source = ts.createSourceFile(
      "/caplets-code-mode/session-cell.ts",
      code,
      ts.ScriptTarget.ES2022,
      true,
    );
    const compilerOptions = codeModeCompilerOptions();
    const ambientDeclarations = [
      CODE_MODE_DIAGNOSTICS_BUILTINS_DECLARATION,
      declaration,
      this.declaration(),
    ].join("\n");
    const host = createVirtualCompilerHost(compilerOptions, {
      [CODE_FILE]: code,
      [AMBIENT_FILE]: ambientDeclarations,
    });
    const program = ts.createProgram([CODE_FILE, AMBIENT_FILE], compilerOptions, host);
    const checker = program.getTypeChecker();
    const programSource = program.getSourceFile(CODE_FILE) ?? source;
    for (const statement of programSource.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const typeParameters = statement.typeParameters
          ? `<${statement.typeParameters.map((typeParameter) => typeParameter.getText(programSource)).join(", ")}>`
          : "";
        const params = statement.parameters.map((parameter) =>
          ambientParameter(parameter, programSource),
        );
        const signature = checker.getSignatureFromDeclaration(statement);
        const inferredReturnType = signature
          ? safeAmbientFunctionReturnType(
              checker.getReturnTypeOfSignature(signature),
              checker,
              ambientDeclarations,
            )
          : "unknown";
        const returnType = statement.type
          ? statement.type.getText(programSource)
          : inferredReturnType;
        this.#declarations.set(
          statement.name.text,
          `declare function ${statement.name.text}${typeParameters}(${params.join(", ")}): ${returnType};`,
        );
      }
    }
    const previousBindingNames = new Set(this.#declarations.keys());
    const assignedNames = collectFunctionScopedAssignedNames(programSource);
    for (const binding of collectFunctionScopedVarBindings(programSource, checker, {
      ambientDeclarationFor: (name) =>
        [CODE_MODE_DIAGNOSTICS_BUILTINS_DECLARATION, declaration, this.declarationExcluding(name)]
          .filter(Boolean)
          .join("\n"),
      assignedNames,
      previousBindingNames,
    })) {
      this.#declarations.set(binding.name, `declare var ${binding.name}: ${binding.type};`);
    }
  }

  clear(): void {
    this.#declarations.clear();
  }

  private declarationExcluding(name: string): string {
    const declarations: string[] = [CODE_MODE_DIAGNOSTICS_BUILTINS_DECLARATION];
    for (const [declarationName, declaration] of this.#declarations) {
      if (declarationName !== name) {
        declarations.push(declaration);
      }
    }
    return declarations.join("\n");
  }
}

type AmbientVarBinding = {
  name: string;
  type: string;
};

type AmbientVarBindingOptions = {
  ambientDeclarationFor: (name: string) => string;
  assignedNames: ReadonlySet<string>;
  previousBindingNames: ReadonlySet<string>;
};

function collectFunctionScopedVarBindings(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  options: AmbientVarBindingOptions,
): AmbientVarBinding[] {
  const bindings = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (node !== source && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
      return;
    }
    if (ts.isVariableStatement(node)) {
      collectVarDeclarationListBindings(node.declarationList, checker, bindings, options);
    }
    if (
      (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      collectVarDeclarationListBindings(node.initializer, checker, bindings, options);
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
  options: AmbientVarBindingOptions,
): void {
  const isVar = (ts.getCombinedNodeFlags(declarationList) & ts.NodeFlags.BlockScoped) === 0;
  if (!isVar) {
    return;
  }
  for (const declaration of declarationList.declarations) {
    for (const name of bindingNames(declaration.name)) {
      const type = ambientTypeForBindingName(
        name,
        checker,
        options.ambientDeclarationFor(name.text),
      );
      if (
        options.previousBindingNames.has(name.text) &&
        declaration.initializer === undefined &&
        !options.assignedNames.has(name.text)
      ) {
        continue;
      }
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

function collectFunctionScopedAssignedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (node !== source && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
      return;
    }
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      collectAssignedBindingNames(node.left, names);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      collectAssignedBindingNames(node.operand, names);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function collectAssignedBindingNames(node: ts.Node, names: Set<string>): void {
  if (ts.isIdentifier(node)) {
    names.add(node.text);
    return;
  }
  if (ts.isPropertyAssignment(node)) {
    collectAssignedBindingNames(node.initializer, names);
    return;
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    names.add(node.name.text);
    return;
  }
  if (ts.isSpreadAssignment(node)) {
    collectAssignedBindingNames(node.expression, names);
    return;
  }
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    ts.forEachChild(node, (child) => collectAssignedBindingNames(child, names));
  }
}

function ambientTypeForBindingName(
  name: ts.Identifier,
  checker: ts.TypeChecker,
  ambientDeclaration: string,
): string {
  const type = checker.getTypeAtLocation(name);
  return safeAmbientType(name.text, type, checker, ambientDeclaration);
}

function safeAmbientType(
  name: string,
  type: ts.Type,
  checker: ts.TypeChecker,
  ambientDeclaration: string,
): string {
  return safeAmbientTypeText(type, checker, ambientDeclaration, (typeText) =>
    isSelfContainedAmbientDeclaration(`declare let ${name}: ${typeText};`, ambientDeclaration),
  );
}

function safeAmbientFunctionReturnType(
  type: ts.Type,
  checker: ts.TypeChecker,
  ambientDeclaration: string,
): string {
  return safeAmbientTypeText(type, checker, ambientDeclaration, (typeText) =>
    isSelfContainedAmbientDeclaration(
      `declare function __caplets_return_probe__(): ${typeText};`,
      ambientDeclaration,
    ),
  );
}

function safeAmbientTypeText(
  type: ts.Type,
  checker: ts.TypeChecker,
  ambientDeclaration: string,
  isSelfContained: (typeText: string) => boolean,
): string {
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
  if (!isSelfContained(text)) {
    return "unknown";
  }
  return text;
}

function isUnsafeAmbientType(type: ts.Type): boolean {
  return Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never));
}

function isSelfContainedAmbientDeclaration(
  candidateDeclaration: string,
  ambientDeclaration: string,
): boolean {
  const compilerOptions = codeModeCompilerOptions();
  const host = createVirtualCompilerHost(compilerOptions, {
    [CODE_FILE]: candidateDeclaration,
    [AMBIENT_FILE]: ambientDeclaration,
  });
  const program = ts.createProgram([CODE_FILE, AMBIENT_FILE], compilerOptions, host);
  return program.getSemanticDiagnostics(program.getSourceFile(CODE_FILE)).length === 0;
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
