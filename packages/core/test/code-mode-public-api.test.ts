import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  codeModeDeclarationHash,
  generateCodeModeDeclarations,
  generateCodeModeRunToolDescription,
  hasDirectFetchCall,
  hasExecutableImport,
  minifyCodeModeDeclarationText,
} from "../src/code-mode/index";

const codeModeSourceRoot = resolve(import.meta.dirname, "../src/code-mode");

describe("@caplets/core/code-mode public API", () => {
  it("imports as a pure API entrypoint without runtime-only exports", () => {
    const entrypoint = readFileSync(resolve(codeModeSourceRoot, "index.ts"), "utf8");

    const forbiddenRuntimeExports = [
      "codeModeRunInputSchema",
      "runCodeMode",
      "RunCodeModeInput",
      "QuickJsCodeModeSandbox",
      "CodeModeSandbox",
      "CodeModeReplSession",
      "CodeModeSessionManager",
      "CodeModeSessionRunInput",
      "CodeModeSessionRunResult",
      "CodeModeJournalStore",
      "CodeModeJournalEntry",
      "StoreCodeModeJournalEntryInput",
      "CODE_MODE_SESSION_COMPATIBILITY_VERSION",
      "DEFAULT_CODE_MODE_SESSION_TTL_MS",
      "DEFAULT_CODE_MODE_SESSION_LIMIT",
    ];
    for (const forbiddenExport of forbiddenRuntimeExports) {
      expect(entrypoint).not.toContain(forbiddenExport);
    }

    expect(entrypointModules(resolve(codeModeSourceRoot, "index.ts"))).toEqual([
      "./declarations",
      "./static-analysis",
      "./types",
    ]);
    expect(transitiveValueImports(resolve(codeModeSourceRoot, "index.ts"))).toEqual([
      "static-analysis.ts imports @babel/parser",
    ]);
  });

  it("exports declaration helpers and static diagnostics through the public entrypoint", () => {
    const declaration = generateCodeModeDeclarations({
      caplets: [{ id: "docs", name: "Docs", description: "Documentation search." }],
    });

    expect(declaration).toContain('docs:CapletHandle<"docs">');
    expect(codeModeDeclarationHash(declaration)).toMatch(/^[a-f0-9]{64}$/u);
    expect(minifyCodeModeDeclarationText("type X = { y: string };")).toBe("type X={y:string};");
    expect(hasDirectFetchCall('const x = "fetch(\\"https://example.com\\")";')).toBe(false);
    expect(hasDirectFetchCall('await fetch("https://example.com");')).toBe(true);
    expect(hasExecutableImport('const x = "import fs from \\"node:fs\\"";')).toBe(false);
    expect(hasExecutableImport('await import("node:fs");')).toBe(true);
    expect(generateCodeModeRunToolDescription(declaration)).toContain(
      "Generated declaration hints:",
    );
    expect(generateCodeModeRunToolDescription(declaration)).toContain(
      'const h=caplets["caplet-id"]',
    );
  });

  it("exports public session and recovery declaration types without runtime stores", () => {
    const entrypoint = readFileSync(resolve(codeModeSourceRoot, "index.ts"), "utf8");

    expect(entrypoint).toContain("CodeModeSessionStatus");
    expect(entrypoint).toContain("ReadCodeModeRecoveryInput");
    expect(entrypoint).toContain("ReadCodeModeRecoveryResult");
    expect(entrypoint).toContain("CodeModeRecoveryEntry");
    expect(entrypoint).not.toContain("CodeModeJournalStore");
    expect(entrypoint).not.toContain("CodeModeSessionManager");
  });
});

function transitiveValueImports(entrypoint: string): string[] {
  const visited = new Set<string>();
  const externalImports = new Set<string>();
  const visit = (filePath: string): void => {
    if (visited.has(filePath)) return;
    visited.add(filePath);

    const source = readFileSync(filePath, "utf8");
    for (const specifier of valueSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        externalImports.add(`${formatCodeModePath(filePath)} imports ${specifier}`);
        continue;
      }

      const child = resolveModule(dirname(filePath), specifier);
      if (child) visit(child);
    }
  };

  visit(entrypoint);
  return [...externalImports].sort();
}

function valueSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  const sourceFile = ts.createSourceFile(
    "/caplets-code-mode-public-api.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause?.isTypeOnly && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (
        !statement.isTypeOnly &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
  }

  return specifiers;
}

function entrypointModules(entrypoint: string): string[] {
  const source = readFileSync(entrypoint, "utf8");
  const modules: string[] = [];

  const sourceFile = ts.createSourceFile(
    "/caplets-code-mode-public-api.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      modules.push(statement.moduleSpecifier.text);
    }
  }

  return modules.sort();
}

function resolveModule(baseDir: string, specifier: string): string | undefined {
  const exact = resolve(baseDir, specifier);
  const candidates = [exact, `${exact}.ts`, resolve(exact, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function formatCodeModePath(filePath: string): string {
  return filePath.slice(codeModeSourceRoot.length + 1);
}
