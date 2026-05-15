import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import corePackage from "../package.json";

const repoRoot = resolve(import.meta.dirname, "../../..");
const packagesRoot = resolve(repoRoot, "packages");

const scannedExtensions = new Set([".ts", ".mjs"]);
const ignoredDirectories = new Set(["dist", "dist-schema", "node_modules"]);

describe("package boundaries", () => {
  it("uses Node ESM-safe MCP SDK subpath imports", () => {
    const violations = scanFiles([packagesRoot]).flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return Array.from(source.matchAll(/["'](@modelcontextprotocol\/sdk\/[^"']+)["']/g))
        .map((match) => match[1])
        .filter((specifier): specifier is string => Boolean(specifier))
        .filter((specifier) => !specifier.endsWith(".js"))
        .map((specifier) => `${formatPath(filePath)} imports ${specifier}`);
    });

    expect(violations).toEqual([]);
  });

  it("imports workspace packages through declared package exports", () => {
    const exportedCoreSpecifiers = new Set(
      Object.keys(corePackage.exports).map((specifier) =>
        specifier === "." ? "@caplets/core" : `@caplets/core/${specifier.slice(2)}`,
      ),
    );
    const violations = scanFiles([packagesRoot]).flatMap((filePath) => {
      const packageName = packageNameForFile(filePath);
      const source = readFileSync(filePath, "utf8");
      const specifiers = importSpecifiers(source);
      const relativeCrossPackageImports = specifiers
        .filter((specifier) => /^\.\.\/(core|cli|opencode|pi|benchmarks)(?:\/|$)/.test(specifier))
        .map((specifier) => `${formatPath(filePath)} imports ${specifier}`);
      const undeclaredCoreExports = specifiers
        .filter((specifier) => specifier.startsWith("@caplets/core"))
        .filter((specifier) => packageName !== "core" && !exportedCoreSpecifiers.has(specifier))
        .map((specifier) => `${formatPath(filePath)} imports undeclared export ${specifier}`);

      return [...relativeCrossPackageImports, ...undeclaredCoreExports];
    });

    expect(violations).toEqual([]);
  });
});

function scanFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    collectFiles(root, files);
  }
  return files;
}

function collectFiles(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        collectFiles(path, files);
      }
      continue;
    }
    if ([...scannedExtensions].some((extension) => entry.name.endsWith(extension))) {
      files.push(path);
    }
  }
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    if (match[1]) specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    if (match[1]) specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/\bvi\.mock\(\s*["']([^"']+)["']/g)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

function packageNameForFile(filePath: string): string | undefined {
  const parts = relative(packagesRoot, filePath).split(sep);
  return parts[0];
}

function formatPath(filePath: string): string {
  return relative(repoRoot, filePath).split(sep).join("/");
}
