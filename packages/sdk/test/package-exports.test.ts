import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import rolldownConfig from "../rolldown.config";
import sdkPackage from "../package.json";

type BuildConfig = {
  input?: string | string[] | Record<string, string>;
  platform?: string;
};

type PackageExport = {
  types?: unknown;
  default?: unknown;
};

const sdkRoot = resolve(import.meta.dirname, "..");
const buildConfigs = (
  Array.isArray(rolldownConfig) ? rolldownConfig : [rolldownConfig]
) as BuildConfig[];
const nodeBuiltins = new Set(builtinModules.map((specifier) => specifier.replace(/^node:/u, "")));

describe("@caplets/sdk package exports", () => {
  it("publishes only the three public ESM entry points", () => {
    expect(sdkPackage.type).toBe("module");
    expect(sdkPackage.version).toBe("0.0.0");
    expect(sdkPackage.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      "./project-binding": {
        types: "./dist/project-binding/index.d.ts",
        default: "./dist/project-binding.js",
      },
      "./project-binding/node": {
        types: "./dist/project-binding/node.d.ts",
        default: "./dist/project-binding/node.js",
      },
    });
  });

  it("gives every export declaration types and one dedicated JavaScript build entry", () => {
    const entries = buildEntries();
    const defaults = new Set<string>();

    for (const [subpath, untypedTarget] of Object.entries(sdkPackage.exports)) {
      const target = untypedTarget as PackageExport;
      expect(target.types, `${subpath} types`).toMatch(/^\.\/dist\/.+\.d\.ts$/u);
      expect(target.default, `${subpath} default`).toMatch(/^\.\/dist\/.+\.js$/u);

      const defaultTarget = target.default as string;
      const matchingEntries = entries.filter(({ name }) => `./dist/${name}.js` === defaultTarget);
      expect(matchingEntries, `${subpath} build entry`).toHaveLength(1);
      expect(defaults.has(defaultTarget), `${subpath} shares ${defaultTarget}`).toBe(false);
      defaults.add(defaultTarget);
    }
  });

  it("keeps browser entries free of Node runtime dependencies and isolates the Node helper", () => {
    const entries = buildEntries();
    const rootEntry = entryForExport(".", entries);
    const projectBindingEntry = entryForExport("./project-binding", entries);
    const nodeEntry = entryForExport("./project-binding/node", entries);

    expect(rootEntry.platform).toBe("browser");
    expect(projectBindingEntry.platform).toBe("browser");
    expect(nodeEntry.platform).toBe("node");

    const browserFiles = collectModuleGraph([rootEntry.source, projectBindingEntry.source]);
    expect(browserFiles).not.toContain(resolve(sdkRoot, nodeEntry.source));

    const violations = browserFiles.flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      const importViolations = importSpecifiers(source)
        .filter(isNodeBuiltin)
        .map((specifier) => `${formatPath(filePath)} imports ${specifier}`);
      const globalViolations = Array.from(source.matchAll(/\b(?:Buffer|process)\b/gu)).map(
        (match) => `${formatPath(filePath)} uses ${match[0]}`,
      );
      return [...importViolations, ...globalViolations];
    });

    expect(violations).toEqual([]);
  });

  it("does not expose generated or private implementation subpaths", () => {
    const exportedSubpaths = Object.keys(sdkPackage.exports);

    expect(exportedSubpaths).not.toContain("./generated");
    expect(exportedSubpaths).not.toContain("./generated/*");
    expect(exportedSubpaths).not.toContain("./src/*");
    expect(exportedSubpaths).not.toContain("./package.json");
    expect(exportedSubpaths.some((subpath) => subpath.includes("*"))).toBe(false);
  });
});

function buildEntries(): Array<{ name: string; source: string; platform?: string }> {
  return buildConfigs.flatMap((config) => {
    if (typeof config.input !== "object" || config.input === null || Array.isArray(config.input)) {
      return [];
    }
    return Object.entries(config.input).map(([name, source]) => ({
      name,
      source,
      ...(config.platform !== undefined ? { platform: config.platform } : {}),
    }));
  });
}

function entryForExport(
  subpath: keyof typeof sdkPackage.exports,
  entries: ReturnType<typeof buildEntries>,
): (typeof entries)[number] {
  const target = sdkPackage.exports[subpath] as PackageExport;
  const entry = entries.find(({ name }) => `./dist/${name}.js` === target.default);
  expect(entry, `${subpath} build entry`).toBeDefined();
  return entry!;
}

function collectModuleGraph(entrySources: string[]): string[] {
  const pending = entrySources.map((source) => resolve(sdkRoot, source));
  const visited = new Set<string>();

  while (pending.length > 0) {
    const filePath = pending.pop()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);

    const source = readFileSync(filePath, "utf8");
    for (const specifier of importSpecifiers(source).filter((value) => value.startsWith("."))) {
      const dependency = resolveSourceModule(filePath, specifier);
      expect(dependency, `${formatPath(filePath)} imports unresolved ${specifier}`).toBeDefined();
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }

  return [...visited];
}

function resolveSourceModule(importer: string, specifier: string): string | undefined {
  const base = resolve(dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    base.replace(/\.js$/u, ".ts"),
    resolve(base, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s+["']([^"']+)["']/gu,
    /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function isNodeBuiltin(specifier: string): boolean {
  const normalized = specifier.replace(/^node:/u, "");
  return specifier.startsWith("node:") || nodeBuiltins.has(normalized);
}

function formatPath(filePath: string): string {
  return relative(sdkRoot, filePath).split(sep).join("/");
}
