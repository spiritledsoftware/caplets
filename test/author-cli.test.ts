import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorCliCaplet } from "../src/cli/author.js";
import { validateCapletFile } from "../src/caplet-files.js";
import { runCli } from "../src/cli.js";

describe("CLI Caplet authoring", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates a valid repo workflow Caplet to stdout text", () => {
    const repo = tempRepo({
      packageManager: "pnpm@11.0.9",
      scripts: { test: "vitest run", lint: "oxlint ." },
    });

    const result = authorCliCaplet("repo-tools", { repo, include: "git,package" });

    expect(result.path).toBeUndefined();
    expect(result.text).toContain("cliTools:");
    expect(result.text).toContain("git_status:");
    expect(result.text).toContain("package_test:");
    expect(result.text).toContain("readOnlyHint: false");
    const path = join(repo, "CAPLET.md");
    writeFileSync(path, result.text);
    expect(() => validateCapletFile(path)).not.toThrow();
  });

  it("writes generated Caplets to an explicit output path", () => {
    const repo = tempRepo({ scripts: { build: "tsc" } });
    const output = join(repo, "repo-tools.md");

    const result = authorCliCaplet("repo-tools", { repo, include: "package", output });

    expect(result.path).toBe(output);
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output, "utf8")).toContain("package_build:");
  });

  it("supports git and gh single command templates", () => {
    const repo = tempRepo({ scripts: { test: "vitest run" } });

    const git = authorCliCaplet("git-tools", { repo, command: "git" }).text;
    expect(git).toContain("git_current_branch:");
    expect(git).not.toContain("package_test:");
    expect(authorCliCaplet("gh-tools", { repo, command: "gh", include: "" }).text).toContain(
      "gh_pr_status:",
    );
  });

  it("is exposed through caplets author cli", async () => {
    const repo = tempRepo({ scripts: { test: "vitest run" } });
    let output = "";

    await runCli(["author", "cli", "repo-tools", "--repo", repo, "--include", "package"], {
      writeOut: (value) => {
        output += value;
      },
    });

    expect(output).toContain("cliTools:");
    expect(output).toContain("package_test:");
  });

  function tempRepo(packageJson: { packageManager?: string; scripts?: Record<string, string> }) {
    const dir = mkdtempSync(join(tmpdir(), "caplets-author-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          ...packageJson,
        },
        null,
        2,
      ),
    );
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    return dir;
  }
});
