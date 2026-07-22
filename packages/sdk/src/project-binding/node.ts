import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT_MARKERS = [".caplets", ".git", "package.json", "pnpm-workspace.yaml"] as const;

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
