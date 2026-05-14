import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

type AuthorCliOptions = {
  repo?: string;
  include?: string;
  command?: string;
  output?: string;
};

type CliAction = {
  description?: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  output?: { type: "text" | "json" };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

export function authorCliCaplet(
  id: string,
  options: AuthorCliOptions = {},
): {
  path?: string;
  text: string;
} {
  const repo = resolve(options.repo ?? process.cwd());
  const include = parseInclude(options.include);
  const actions: Record<string, CliAction> = {};

  if (include.has("git") || options.command === "git") {
    Object.assign(actions, gitActions(repo));
  }
  if (include.has("gh") || options.command === "gh") {
    Object.assign(actions, ghActions(repo));
  }
  if (include.has("package") || isPackageCommand(options.command)) {
    Object.assign(actions, packageActions(repo, options.command));
  }

  if (options.command && Object.keys(actions).length === 0) {
    actions[`${sanitizeId(options.command)}_version`] = {
      description: `Print ${options.command} version information.`,
      command: options.command,
      args: ["--version"],
      annotations: { readOnlyHint: true },
    };
  }

  if (Object.keys(actions).length === 0) {
    throw new Error("No CLI actions could be generated for the requested options");
  }

  const text = renderCaplet({
    name: titleize(id),
    description: `Curated CLI tools for ${basename(repo)} workflows.`,
    cwd: repo,
    actions,
  });
  const output = options.output ?? "-";
  if (output !== "-") {
    writeFileSync(output, text);
    return { path: output, text };
  }
  return { text };
}

function parseInclude(value: string | undefined): Set<string> {
  if (!value) {
    return new Set(["git", "gh", "package"]);
  }
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function gitActions(repo: string): Record<string, CliAction> {
  return {
    git_status: {
      description: "Show concise Git working tree status.",
      command: "git",
      args: ["status", "--short"],
      cwd: repo,
      annotations: { readOnlyHint: true },
    },
    git_current_branch: {
      description: "Print the current Git branch name.",
      command: "git",
      args: ["branch", "--show-current"],
      cwd: repo,
      annotations: { readOnlyHint: true },
    },
    git_changed_files: {
      description: "List changed tracked and untracked files.",
      command: "git",
      args: ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd: repo,
      annotations: { readOnlyHint: true },
    },
  };
}

function ghActions(repo: string): Record<string, CliAction> {
  return {
    gh_pr_status: {
      description: "Show pull request status for the current branch as JSON.",
      command: "gh",
      args: ["pr", "status", "--json", "currentBranch"],
      cwd: repo,
      output: { type: "json" },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    gh_issue_list: {
      description: "List open GitHub issues as JSON.",
      command: "gh",
      args: ["issue", "list", "--json", "number,title,state,url"],
      cwd: repo,
      output: { type: "json" },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
  };
}

function packageActions(
  repo: string,
  explicitCommand: string | undefined,
): Record<string, CliAction> {
  const packageJsonPath = join(repo, "package.json");
  if (!existsSync(packageJsonPath)) {
    return {};
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
    packageManager?: string;
  };
  const manager =
    explicitCommand && isPackageCommand(explicitCommand)
      ? explicitCommand
      : detectPackageManager(repo, packageJson);
  const scripts = packageJson.scripts ?? {};
  const actions: Record<string, CliAction> = {};
  for (const script of ["test", "lint", "typecheck", "build", "verify"]) {
    if (!scripts[script]) {
      continue;
    }
    actions[`package_${script}`] = {
      description: `Run the package ${script} script.`,
      command: manager,
      args: ["run", script],
      cwd: repo,
      annotations: { readOnlyHint: script !== "build" },
      ...(script === "test" || script === "verify" ? { timeoutMs: 120_000 } : {}),
    } as CliAction;
  }
  return actions;
}

function detectPackageManager(
  repo: string,
  packageJson: { packageManager?: string },
): "pnpm" | "npm" | "bun" | "yarn" {
  if (packageJson.packageManager?.startsWith("pnpm@")) {
    return "pnpm";
  }
  if (packageJson.packageManager?.startsWith("bun@")) {
    return "bun";
  }
  if (packageJson.packageManager?.startsWith("yarn@")) {
    return "yarn";
  }
  if (existsSync(join(repo, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(repo, "bun.lockb")) || existsSync(join(repo, "bun.lock"))) {
    return "bun";
  }
  if (existsSync(join(repo, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

function isPackageCommand(command: string | undefined): command is "pnpm" | "npm" | "bun" | "yarn" {
  return command === "pnpm" || command === "npm" || command === "bun" || command === "yarn";
}

function renderCaplet(input: {
  name: string;
  description: string;
  cwd: string;
  actions: Record<string, CliAction>;
}): string {
  const lines = [
    "---",
    "$schema: https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json",
    `name: ${yamlString(input.name)}`,
    `description: ${yamlString(input.description)}`,
    "tags:",
    "  - cli",
    "  - code",
    "cliTools:",
    `  cwd: ${yamlString(input.cwd)}`,
    "  actions:",
  ];
  for (const [name, action] of Object.entries(input.actions).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`    ${name}:`);
    if (action.description) {
      lines.push(`      description: ${yamlString(action.description)}`);
    }
    lines.push(`      command: ${yamlString(action.command)}`);
    if (action.args?.length) {
      lines.push("      args:");
      for (const arg of action.args) {
        lines.push(`        - ${yamlString(arg)}`);
      }
    }
    if (action.cwd && action.cwd !== input.cwd) {
      lines.push(`      cwd: ${yamlString(action.cwd)}`);
    }
    if (action.timeoutMs) {
      lines.push(`      timeoutMs: ${action.timeoutMs}`);
    }
    if (action.maxOutputBytes) {
      lines.push(`      maxOutputBytes: ${action.maxOutputBytes}`);
    }
    if (action.output) {
      lines.push("      output:");
      lines.push(`        type: ${action.output.type}`);
    }
    if (action.annotations) {
      lines.push("      annotations:");
      for (const [key, value] of Object.entries(action.annotations)) {
        lines.push(`        ${key}: ${value ? "true" : "false"}`);
      }
    }
  }
  lines.push("---", "", `# ${input.name}`, "", input.description, "");
  return `${lines.join("\n")}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function titleize(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "cli";
}
