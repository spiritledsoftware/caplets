import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT_MARKERS = [".caplets", ".git", "package.json", "pnpm-workspace.yaml"] as const;

export function findProjectRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function fingerprintProjectRoot(root: string): string {
  const resolved = resolve(root);
  const hash = createHash("sha256");
  hash.update(resolved);
  for (const marker of ROOT_MARKERS) {
    const path = join(resolved, marker);
    if (!existsSync(path)) continue;
    hash.update(marker);
    try {
      const stat = statSync(path);
      hash.update(stat.isDirectory() ? "directory" : readFileSync(path));
    } catch {
      hash.update("unreadable");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}
