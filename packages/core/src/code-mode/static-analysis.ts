import ts from "typescript";

const CODE_MODE_STATIC_ANALYSIS_FILE = "/caplets-code-mode/static-analysis-input.ts";

export function hasDirectFetchCall(code: string): boolean {
  const executableSource = maskLiteralsAndComments(code);
  return (
    /(^|[^\w$.\]])fetch\s*(?:\?\.)?\s*\(/u.test(executableSource) ||
    /\b(?:globalThis|window|self)\s*(?:\.\s*fetch|\[\s*["']fetch["']\s*\])\s*(?:\?\.)?\s*\(/u.test(
      executableSource,
    )
  );
}

export function hasExecutableImport(code: string): boolean {
  const source = ts.createSourceFile(
    CODE_MODE_STATIC_ANALYSIS_FILE,
    code,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)
    ) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

function maskLiteralsAndComments(code: string): string {
  let output = "";
  let index = 0;
  while (index < code.length) {
    const char = code[index]!;
    const next = code[index + 1];
    if (char === '"' || char === "'" || char === "`") {
      const masked = maskQuoted(code, index, char);
      output += masked.text;
      index = masked.nextIndex;
      continue;
    }
    if (char === "/" && next === "/") {
      const masked = maskLineComment(code, index);
      output += masked.text;
      index = masked.nextIndex;
      continue;
    }
    if (char === "/" && next === "*") {
      const masked = maskBlockComment(code, index);
      output += masked.text;
      index = masked.nextIndex;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function maskQuoted(
  code: string,
  start: number,
  quote: '"' | "'" | "`",
): { text: string; nextIndex: number } {
  let text = " ";
  let index = start + 1;
  while (index < code.length) {
    const char = code[index]!;
    text += char === "\n" ? "\n" : " ";
    index += char === "\\" ? 2 : 1;
    if (char === quote) break;
  }
  return { text, nextIndex: index };
}

function maskLineComment(code: string, start: number): { text: string; nextIndex: number } {
  let text = "  ";
  let index = start + 2;
  while (index < code.length && code[index] !== "\n") {
    text += " ";
    index += 1;
  }
  return { text, nextIndex: index };
}

function maskBlockComment(code: string, start: number): { text: string; nextIndex: number } {
  let text = "  ";
  let index = start + 2;
  while (index < code.length) {
    const char = code[index]!;
    const next = code[index + 1];
    text += char === "\n" ? "\n" : " ";
    index += 1;
    if (char === "*" && next === "/") {
      text += " ";
      index += 1;
      break;
    }
  }
  return { text, nextIndex: index };
}
