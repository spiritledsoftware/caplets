import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export class ProjectSyncCoordinator {
  private readonly queues = new Map<string, Promise<void>>();

  async runMutating<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => next);
    this.queues.set(projectId, queued);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.queues.get(projectId) === queued) {
        this.queues.delete(projectId);
      }
    }
  }
}

export function projectSyncManifest(projectRoot: string): string[] {
  const ignoreRules = readIgnoreRules(projectRoot);
  const files: string[] = [];
  walk(projectRoot, projectRoot, ignoreRules, files);
  return files.sort();
}

function walk(root: string, current: string, ignoreRules: string[], files: string[]): void {
  for (const entry of readdirSync(current)) {
    const absolute = join(current, entry);
    const relativePath = relative(root, absolute).replace(/\\/gu, "/");
    if (
      relativePath === ".git" ||
      relativePath === ".caplets-sync" ||
      ignored(relativePath, ignoreRules)
    ) {
      continue;
    }
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      walk(root, absolute, ignoreRules, files);
    } else if (stat.isFile()) {
      files.push(relativePath);
    }
  }
}

function readIgnoreRules(projectRoot: string): string[] {
  return [".gitignore", join(".git", "info", "exclude"), ".capletsignore"].flatMap((file) => {
    const path = join(projectRoot, file);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  });
}

function ignored(path: string, rules: string[]): boolean {
  let ignoredPath = false;
  for (const rule of rules) {
    const negated = rule.startsWith("!");
    const pattern = (negated ? rule.slice(1) : rule).replace(/^\/+/u, "");
    if (!pattern) continue;
    if (matchesIgnorePattern(path, pattern)) {
      ignoredPath = !negated;
    }
  }
  return ignoredPath;
}

function matchesIgnorePattern(path: string, pattern: string): boolean {
  const directoryPattern = pattern.endsWith("/");
  const normalized = pattern.replace(/\/$/u, "");
  const candidates = normalized.includes("/")
    ? [path]
    : path.split("/").map((_, index, parts) => parts.slice(index).join("/"));
  return candidates.some((candidate) => {
    if (globMatch(candidate, normalized)) return true;
    return directoryPattern && candidate.startsWith(`${normalized}/`);
  });
}

function globMatch(value: string, pattern: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
      .join("[^/]*")}(?:/.*)?$`,
    "u",
  );
  return regex.test(value);
}
