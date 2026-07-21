import { existsSync } from "node:fs";
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
