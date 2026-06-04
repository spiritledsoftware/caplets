import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type ProjectSyncExclusionSource = "hard_denylist" | "gitignore" | "capletsignore";

export type ProjectSyncExclusionSummary = {
  source: ProjectSyncExclusionSource;
  pattern: string;
  count: number;
};

export type ProjectSyncManifestFile = {
  relativePath: string;
  sizeBytes: number;
};

export type ProjectSyncManifest = {
  projectRoot: string;
  files: ProjectSyncManifestFile[];
  totalBytes: number;
  exclusionSummary: ProjectSyncExclusionSummary[];
};

const HARD_DENYLIST = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  "dist/",
  "build/",
  "coverage/",
  ".DS_Store",
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "*.pem",
  "*.key",
  "*.p12",
  "*.zip",
  "*.tar",
  "*.tar.gz",
  "*.tgz",
  "*.rar",
  "*.7z",
];

const SAFE_TEMPLATE_ALLOWLIST = [/^\.env\.(example|sample|template)$/u];

export function buildProjectSyncManifest(input: { projectRoot: string }): ProjectSyncManifest {
  const gitignore = [
    ...loadIgnoreFile(input.projectRoot, ".gitignore"),
    ...loadIgnoreFile(input.projectRoot, join(".git", "info", "exclude")),
  ];
  const capletsignore = loadIgnoreFile(input.projectRoot, ".capletsignore");
  const files: ProjectSyncManifestFile[] = [];
  const excluded = new Map<string, ProjectSyncExclusionSummary>();

  walk(input.projectRoot, (absolutePath, directory) => {
    const relativePath = normalizeRelative(relative(input.projectRoot, absolutePath));
    if (!relativePath) return true;
    const denial = hardDenylistPattern(relativePath, directory);
    if (denial && !safeTemplate(relativePath)) {
      addExcluded(excluded, "hard_denylist", denial);
      return false;
    }
    const gitPattern = matchingIgnorePattern(gitignore, relativePath, directory);
    if (gitPattern) {
      addExcluded(excluded, "gitignore", gitPattern);
      return false;
    }
    const capletsPattern = matchingIgnorePattern(capletsignore, relativePath, directory);
    if (capletsPattern && !safeTemplate(relativePath)) {
      addExcluded(excluded, "capletsignore", capletsPattern);
      return false;
    }
    if (!directory) {
      files.push({ relativePath, sizeBytes: statSync(absolutePath).size });
    }
    return true;
  });

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    projectRoot: input.projectRoot,
    files,
    totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    exclusionSummary: [...excluded.values()].sort((a, b) =>
      `${a.source}:${a.pattern}`.localeCompare(`${b.source}:${b.pattern}`),
    ),
  };
}

function walk(root: string, visit: (absolutePath: string, directory: boolean) => boolean): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = join(root, entry.name);
    const directory = entry.isDirectory();
    if (!visit(absolutePath, directory)) continue;
    if (directory) walk(absolutePath, visit);
  }
}

function loadIgnoreFile(root: string, name: string): string[] {
  const path = join(root, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));
}

function matchingIgnorePattern(
  patterns: string[],
  relativePath: string,
  directory: boolean,
): string | undefined {
  return patterns.find((pattern) => matchesPattern(relativePath, pattern, directory));
}

function hardDenylistPattern(relativePath: string, directory: boolean): string | undefined {
  return HARD_DENYLIST.find((pattern) => matchesPattern(relativePath, pattern, directory));
}

function matchesPattern(relativePath: string, pattern: string, directory: boolean): boolean {
  const normalized = pattern.replace(/\\/gu, "/").replace(/^\//u, "");
  if (normalized.endsWith("/")) {
    const prefix = normalized.slice(0, -1);
    return directory
      ? relativePath === prefix || relativePath.startsWith(`${prefix}/`)
      : relativePath.startsWith(`${prefix}/`);
  }
  if (normalized.startsWith("*.")) return relativePath.endsWith(normalized.slice(1));
  return (
    relativePath === normalized ||
    relativePath.startsWith(`${normalized}/`) ||
    relativePath.split("/").includes(normalized)
  );
}

function safeTemplate(relativePath: string): boolean {
  return SAFE_TEMPLATE_ALLOWLIST.some((pattern) => pattern.test(relativePath));
}

function addExcluded(
  excluded: Map<string, ProjectSyncExclusionSummary>,
  source: ProjectSyncExclusionSource,
  pattern: string,
): void {
  const key = `${source}:${pattern}`;
  const existing = excluded.get(key);
  excluded.set(key, { source, pattern, count: (existing?.count ?? 0) + 1 });
}

function normalizeRelative(value: string): string {
  return value.split(sep).join("/");
}
