import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import corePackage from "../package.json";

const repoRoot = resolve(import.meta.dirname, "../../..");
const packagesRoot = resolve(repoRoot, "packages");
const workspaceRoots = ["apps", "packages", "tools"].map((directory) =>
  resolve(repoRoot, directory),
);
const scannedRoots = [...workspaceRoots, resolve(repoRoot, "scripts")];
const sdkRoot = resolve(packagesRoot, "sdk");
const sdkGeneratedRoot = resolve(sdkRoot, "src/generated");
const sdkPackage = JSON.parse(readFileSync(resolve(sdkRoot, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, unknown>;
};
const workspacePackages = collectWorkspacePackages();

const scannedExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
]);
const ignoredDirectories = new Set([".astro", ".turbo", "coverage", "dist", "node_modules"]);

describe("package boundaries", () => {
  it("keeps native-facing production code from writing directly to stdio", () => {
    const nativeFacingRoots = [
      resolve(packagesRoot, "core/src/native"),
      resolve(packagesRoot, "opencode/src"),
      resolve(packagesRoot, "pi/src"),
    ];
    const violations = scanFiles(nativeFacingRoots).flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return Array.from(
        source.matchAll(
          /\bconsole\.(?:log|info|warn|error|debug|trace)\b|process\.(?:stdout|stderr)\.write\b/g,
        ),
      ).map((match) => `${formatPath(filePath)} uses ${match[0]}`);
    });

    expect(violations).toEqual([]);
  });

  it("ignores missing scan roots", () => {
    expect(scanFiles([resolve(packagesRoot, "missing-package/src")])).toEqual([]);
  });

  it("keeps MCP SDK subpath imports extensionless for bundler resolution", () => {
    const violations = scanFiles([packagesRoot]).flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return Array.from(source.matchAll(/["'](@modelcontextprotocol\/sdk\/[^"']+)["']/g))
        .map((match) => match[1])
        .filter((specifier): specifier is string => Boolean(specifier))
        .filter((specifier) => specifier.endsWith(".js"))
        .map((specifier) => `${formatPath(filePath)} imports ${specifier}`);
    });

    expect(violations).toEqual([]);
  });

  it("keeps storage independent of CLI modules", () => {
    const storageRoot = resolve(packagesRoot, "core/src/storage");
    const violations = scanFiles([storageRoot]).flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return importSpecifiers(source)
        .filter((specifier) => specifier.startsWith("."))
        .filter((specifier) => /(?:^|\/)cli(?:\/|$)/.test(specifier))
        .map((specifier) => `${formatPath(filePath)} imports CLI module ${specifier}`);
    });

    expect(violations).toEqual([]);
  });

  it("imports workspace packages through declared package exports", () => {
    const publishedPackages = [
      { manifest: corePackage, name: "@caplets/core" },
      { manifest: sdkPackage, name: "@caplets/sdk" },
    ] as const;
    const declaredExports = new Map(
      publishedPackages.map(({ manifest, name }) => [
        name,
        new Set(
          Object.keys(manifest.exports).map((specifier) =>
            specifier === "." ? name : `${name}/${specifier.slice(2)}`,
          ),
        ),
      ]),
    );

    const violations = scanFiles(workspaceRoots).flatMap((filePath) => {
      const sourcePackage = workspacePackageForFile(filePath);
      const source = readFileSync(filePath, "utf8");
      const specifiers = importSpecifiers(source);
      const relativeCrossPackageImports = specifiers
        .filter((specifier) => {
          const targetPackage = workspacePackageForFile(resolve(dirname(filePath), specifier));
          const crossesPackage = targetPackage !== undefined && targetPackage !== sourcePackage;
          const targetsSdk = targetPackage?.manifest.name === "@caplets/sdk";
          const matchesLegacyPackageRule = /^\.\.\/(core|cli|opencode|pi|benchmarks)(?:\/|$)/u.test(
            specifier,
          );
          return crossesPackage && (targetsSdk || matchesLegacyPackageRule);
        })
        .map((specifier) => `${formatPath(filePath)} imports ${specifier}`);
      const packageImportViolations = specifiers.flatMap((specifier) => {
        const publishedPackage = publishedPackages.find(
          ({ name }) => specifier === name || specifier.startsWith(`${name}/`),
        );
        if (!publishedPackage || sourcePackage?.manifest.name === publishedPackage.name) return [];

        const messages: string[] = [];
        if (!declaredExports.get(publishedPackage.name)?.has(specifier)) {
          messages.push(`${formatPath(filePath)} imports undeclared export ${specifier}`);
        }

        const dependencyVersion = [
          sourcePackage?.manifest.dependencies,
          sourcePackage?.manifest.devDependencies,
          sourcePackage?.manifest.peerDependencies,
          sourcePackage?.manifest.optionalDependencies,
        ]
          .map((dependencies) => dependencies?.[publishedPackage.name])
          .find((version) => version !== undefined);
        if (!dependencyVersion?.startsWith("workspace:")) {
          messages.push(
            `${formatPath(filePath)} imports ${publishedPackage.name} without a workspace dependency`,
          );
        }
        return messages;
      });

      return [...relativeCrossPackageImports, ...packageImportViolations];
    });

    expect(violations).toEqual([]);
  });

  it("rejects the obsolete core client alias and direct SDK generated imports", () => {
    const obsoleteCoreClient = ["@caplets/core", "admin-client"].join("/");
    const generatedPackagePrefixes = [
      ["@caplets/sdk", "generated"].join("/"),
      ["@caplets/sdk", "src", "generated"].join("/"),
    ];
    const violations = scanFiles(scannedRoots).flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      const obsoleteAlias = source.includes(obsoleteCoreClient)
        ? [`${formatPath(filePath)} references ${obsoleteCoreClient}`]
        : [];
      const generatedImports = importSpecifiers(source)
        .filter((specifier) => {
          if (generatedPackagePrefixes.some((prefix) => specifier.startsWith(prefix))) return true;
          if (!specifier.startsWith(".")) return false;
          const target = resolve(dirname(filePath), specifier);
          const relativeTarget = relative(sdkGeneratedRoot, target);
          return (
            relativeTarget === "" ||
            (!relativeTarget.startsWith("..") && !isAbsolute(relativeTarget))
          );
        })
        .filter(() => !isSdkGenerationOrTest(filePath))
        .map((specifier) => `${formatPath(filePath)} imports SDK generated internal ${specifier}`);
      return [...obsoleteAlias, ...generatedImports];
    });

    expect(violations).toEqual([]);
  });

  it("declares type definitions for every published core export", () => {
    const missingTypeDefinitions = Object.entries(corePackage.exports).flatMap(
      ([specifier, target]) => {
        if (typeof target !== "object" || target === null || !("types" in target)) {
          return [`@caplets/core ${specifier} export is missing a types condition`];
        }

        const typesTarget = (target as { types?: unknown }).types;
        if (typeof typesTarget !== "string" || !typesTarget.endsWith(".d.ts")) {
          return [
            `@caplets/core ${specifier} export has invalid types target ${String(typesTarget)}`,
          ];
        }

        return [];
      },
    );

    expect(missingTypeDefinitions).toEqual([]);
  });

  it("pins add-mcp to the validated programmatic contract", () => {
    expect(corePackage.dependencies["add-mcp"]).toBe("1.13.0");
  });

  it("does not publish obsolete Cloud-specific runtime exports", () => {
    expect(Object.keys(corePackage.exports)).not.toContain("./cloud-runtime");
    expect(Object.keys(corePackage.exports)).not.toContain("./cloud/bundle-runtime");
  });

  it("keeps Worker-safe core exports on dedicated bundles", () => {
    const dedicatedExports = [
      "./caplet-source",
      "./catalog",
      "./observed-output-shapes/pure",
      "./project-binding",
      "./redaction",
      "./runtime-plan",
      "./stable-json",
    ] as const;
    const rootDefault = (corePackage.exports["."] as { default: string }).default;

    for (const specifier of dedicatedExports) {
      const target = corePackage.exports[specifier] as { default: string; types: string };

      expect(target.default, specifier).not.toBe(rootDefault);
      expect(target.default, specifier).not.toBe("./dist/index.js");
      expect(target.types, specifier).not.toBe("./dist/index.d.ts");
    }
  });
});

function scanFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    if (existsSync(root)) {
      collectFiles(root, files);
    }
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
  for (const match of source.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
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

interface WorkspacePackage {
  root: string;
  manifest: {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
}

function collectWorkspacePackages(): WorkspacePackage[] {
  return workspaceRoots.flatMap((workspaceRoot) => {
    if (!existsSync(workspaceRoot)) return [];
    return readdirSync(workspaceRoot, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const root = resolve(workspaceRoot, entry.name);
      const manifestPath = resolve(root, "package.json");
      if (!existsSync(manifestPath)) return [];
      const manifest = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as WorkspacePackage["manifest"];
      return manifest.name ? [{ root, manifest }] : [];
    });
  });
}

function workspacePackageForFile(filePath: string): WorkspacePackage | undefined {
  return workspacePackages.find(({ root }) => {
    const relativePath = relative(root, filePath);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
}

function isSdkGenerationOrTest(filePath: string): boolean {
  const relativeSdkPath = relative(sdkRoot, filePath);
  if (!relativeSdkPath.startsWith("..") && !isAbsolute(relativeSdkPath)) return true;
  const relativeGeneratorPath = relative(resolve(repoRoot, "tools/sdk-generator"), filePath);
  if (!relativeGeneratorPath.startsWith("..") && !isAbsolute(relativeGeneratorPath)) return true;
  return (
    filePath === resolve(repoRoot, "scripts/generate-openapi.ts") ||
    filePath === resolve(repoRoot, "scripts/sdk-artifacts.test.ts")
  );
}

function formatPath(filePath: string): string {
  return relative(repoRoot, filePath).split(sep).join("/");
}
