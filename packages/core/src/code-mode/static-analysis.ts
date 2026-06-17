import { parse } from "@babel/parser";
import type { ParserOptions } from "@babel/parser";

type AstNode = {
  type: string;
  [key: string]: unknown;
};

const PARSER_OPTIONS: ParserOptions = {
  sourceType: "module",
  errorRecovery: true,
  allowReturnOutsideFunction: true,
  plugins: ["typescript", "topLevelAwait", "importAttributes"],
};

export function hasDirectFetchCall(code: string): boolean {
  return hasMatchingAstNode(code, (node) => isCallExpression(node) && isFetchCallee(node.callee));
}

export function hasExecutableImport(code: string): boolean {
  return hasMatchingAstNode(code, isExecutableImportNode);
}

function hasMatchingAstNode(code: string, predicate: (node: AstNode) => boolean): boolean {
  const ast = parseCode(code);
  if (!ast) return false;

  let found = false;
  visitAst(ast, (node) => {
    if (found) return;
    found = predicate(node);
  });
  return found;
}

function parseCode(code: string): AstNode | undefined {
  try {
    return parse(code, PARSER_OPTIONS) as unknown as AstNode;
  } catch {
    return undefined;
  }
}

function isExecutableImportNode(node: AstNode): boolean {
  if (
    node.type === "ImportDeclaration" ||
    node.type === "TSImportEqualsDeclaration" ||
    (isExportDeclaration(node) && node.source != null)
  ) {
    return true;
  }
  return isCallExpression(node) && isNode(node.callee) && node.callee.type === "Import";
}

function isCallExpression(node: AstNode): node is AstNode & { callee: unknown } {
  return (
    (node.type === "CallExpression" || node.type === "OptionalCallExpression") && "callee" in node
  );
}

function isFetchCallee(value: unknown): boolean {
  if (!isNode(value)) return false;
  if (isFetchReference(value)) return true;
  if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
    return isGlobalFetchMember(value) || isFetchMethodMember(value);
  }
  return false;
}

function isFetchReference(value: unknown): boolean {
  return isIdentifierNamed(value, "fetch");
}

function isGlobalFetchMember(node: AstNode): boolean {
  if (!isIdentifierNamed(node.object, "globalThis", "window", "self")) return false;
  if (node.computed === true) return isStringLiteralNamed(node.property, "fetch");
  return isIdentifierNamed(node.property, "fetch");
}

function isFetchMethodMember(node: AstNode): boolean {
  if (!isFetchReference(node.object)) return false;
  if (node.computed === true) {
    return (
      isStringLiteralNamed(node.property, "call") ||
      isStringLiteralNamed(node.property, "apply") ||
      isStringLiteralNamed(node.property, "bind")
    );
  }
  return isIdentifierNamed(node.property, "call", "apply", "bind");
}

function isExportDeclaration(node: AstNode): boolean {
  return (
    node.type === "ExportAllDeclaration" ||
    node.type === "ExportDefaultDeclaration" ||
    node.type === "ExportNamedDeclaration"
  );
}

function visitAst(value: unknown, visit: (node: AstNode) => void): void {
  if (!isNode(value)) return;
  visit(value);

  for (const [key, child] of Object.entries(value)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
    if (Array.isArray(child)) {
      for (const item of child) visitAst(item, visit);
      continue;
    }
    visitAst(child, visit);
  }
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function isIdentifierNamed(value: unknown, ...names: string[]): boolean {
  return isNode(value) && value.type === "Identifier" && names.includes(String(value.name));
}

function isStringLiteralNamed(value: unknown, name: string): boolean {
  return isNode(value) && value.type === "StringLiteral" && value.value === name;
}
