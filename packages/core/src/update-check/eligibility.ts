import { isUpdateCheckDisabled, isUpdateNoticeStderrOptIn, type UpdateCheckEnv } from "./control";

export type UpdateNoticeEligibility =
  | { eligible: true; command: string }
  | { eligible: false; reason: string };

export type UpdateNoticeEligibilityInput = {
  args: string[];
  env?: UpdateCheckEnv | undefined;
  stderrIsTTY?: boolean | undefined;
};

export function classifyUpdateNoticeEligibility(
  input: UpdateNoticeEligibilityInput,
): UpdateNoticeEligibility {
  const env = input.env ?? process.env;
  const args = input.args;
  const command = args[0] ?? "";
  const optedIn = isUpdateNoticeStderrOptIn(env);

  if (isUpdateCheckDisabled(env)) return { eligible: false, reason: "disabled" };
  if (args.length === 0) return { eligible: false, reason: "no_args" };
  if (isHelpOrVersion(args)) return { eligible: false, reason: "help_or_version" };
  if (command === "completion" || command === "__complete") {
    return { eligible: false, reason: "completion" };
  }
  if (isOutputProduct(args)) return { eligible: false, reason: "output_product" };
  if (command === "daemon") return { eligible: false, reason: "daemon" };
  if (command === "code-mode") return { eligible: false, reason: "code_mode" };
  if (isCi(env) && !optedIn) return { eligible: false, reason: "ci" };
  if (!input.stderrIsTTY && !optedIn) return { eligible: false, reason: "noninteractive" };
  if (command === "attach") {
    return optedIn ? { eligible: true, command } : { eligible: false, reason: "stdio" };
  }
  if (command === "serve") {
    const transport = optionValue(args, "--transport");
    const daemonSubcommand = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
    if (daemonSubcommand === "start" || daemonSubcommand === "enable") {
      return { eligible: false, reason: "daemon" };
    }
    if (transport === "http" || transport === "sse") return { eligible: true, command };
    return optedIn ? { eligible: true, command } : { eligible: false, reason: "stdio" };
  }

  return { eligible: true, command };
}

function isHelpOrVersion(args: string[]): boolean {
  return args.some(
    (arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V",
  );
}

function isOutputProduct(args: string[]): boolean {
  if (args.some((arg) => arg === "--json" || arg.toLowerCase() === "--format=json")) return true;
  const format = optionValue(args, "--format");
  if (format?.toLowerCase() === "json") return true;
  if (args[0] === "config" && (args[1] === "path" || args[1] === "paths")) return true;
  if (args[0] === "telemetry" && args[1] === "debug") return true;
  return false;
}

function isCi(env: UpdateCheckEnv): boolean {
  return isTruthyEnv(env.CI) || isTruthyEnv(env.GITHUB_ACTIONS) || isTruthyEnv(env.BUILDKITE);
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function optionValue(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1];
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}
