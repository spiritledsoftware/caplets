import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const recursionGuardEnv = "BYTEROVER_CONTEXT_COMMIT";
const commitMessage = "docs(agents): byterover context";

export type ByteRoverStatus = {
  hasChanges: boolean;
};

export function checkByteRoverStatus(porcelainOutput: string): ByteRoverStatus {
  return { hasChanges: porcelainOutput.trim().length > 0 };
}

export function buildCommitArgs(): string[] {
  return ["commit", "--no-verify", "-m", commitMessage];
}

export function formatCheckWarning(): string {
  return [
    "ByteRover context has uncommitted changes.",
    "These changes are advisory and will not block this push.",
    "Run `pnpm exec tsx ./scripts/commit-byterover-context.ts` to commit them.",
  ].join("\n");
}

function runGit(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }

  return result.stdout;
}

function isCheckMode(args: string[]): boolean {
  return args.includes("--check");
}

export function main(args = process.argv.slice(2)): number {
  if (process.env[recursionGuardEnv] === "1") {
    return 0;
  }

  const status = checkByteRoverStatus(runGit(["status", "--porcelain", "--", ".brv"]));

  if (!status.hasChanges) {
    return 0;
  }

  if (isCheckMode(args)) {
    console.warn(formatCheckWarning());
    return 0;
  }

  runGit(["add", "--", ".brv"]);
  const stagedStatus = checkByteRoverStatus(
    runGit(["diff", "--cached", "--name-status", "--", ".brv"]),
  );

  if (!stagedStatus.hasChanges) {
    return 0;
  }

  runGit(buildCommitArgs(), { ...process.env, [recursionGuardEnv]: "1" });
  return 0;
}

const currentFilePath = fileURLToPath(import.meta.url);

if (process.argv[1] === currentFilePath) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
