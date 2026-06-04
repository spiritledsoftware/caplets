import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CAPLETS_GITIGNORE_CONTENT = "*\n!.gitignore\n";

export type ProjectBindingGitignoreBootstrap = {
  path: string;
  changed: boolean;
};

export function bootstrapProjectBindingGitignore(
  projectRoot: string,
): ProjectBindingGitignoreBootstrap {
  const capletsDir = join(projectRoot, ".caplets");
  const gitignorePath = join(capletsDir, ".gitignore");
  if (!existsSync(projectRoot)) return { path: gitignorePath, changed: false };
  mkdirSync(capletsDir, { recursive: true });

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, CAPLETS_GITIGNORE_CONTENT, { mode: 0o600 });
    return { path: gitignorePath, changed: true };
  }

  const existing = readFileSync(gitignorePath, "utf8");
  if (existing.startsWith(CAPLETS_GITIGNORE_CONTENT)) {
    return { path: gitignorePath, changed: false };
  }

  writeFileSync(gitignorePath, `${CAPLETS_GITIGNORE_CONTENT}${existing}`, { mode: 0o600 });
  return { path: gitignorePath, changed: true };
}
