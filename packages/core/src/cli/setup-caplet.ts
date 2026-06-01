import type { CapletConfig } from "../config";
import { loadConfig, resolveConfigPath, resolveProjectConfigPath } from "../config";
import { CapletsError } from "../errors";
import { capletSetupContentHash } from "../setup/hash";
import { LocalSetupStore } from "../setup/local-store";
import { runCapletSetup, type SetupSpawn } from "../setup/runner";
import type { SetupActor, SetupTargetKind } from "../setup/types";

export type CapletSetupCliOptions = {
  yes?: boolean;
  target?: SetupTargetKind;
  remote?: boolean;
  configPath?: string | undefined;
  projectConfigPath?: string | undefined;
  baseDir?: string | undefined;
  spawn?: SetupSpawn;
};

export async function runCapletSetupCli(
  capletId: string,
  options: CapletSetupCliOptions = {},
): Promise<string> {
  const targetKind = resolveSetupTarget(options);
  if (targetKind === "cloud") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Cloud setup runs through the Caplets Cloud API, not the local CLI runner",
    );
  }

  const configPath = options.configPath ?? resolveConfigPath();
  const projectConfigPath = options.projectConfigPath ?? resolveProjectConfigPath();
  const config = loadConfig(configPath, projectConfigPath);
  const caplet = Object.values({
    ...config.mcpServers,
    ...config.openapiEndpoints,
    ...config.graphqlEndpoints,
    ...config.httpApis,
    ...config.cliTools,
    ...config.capletSets,
  }).find((entry) => entry.server === capletId);
  if (!caplet) throw new CapletsError("CONFIG_INVALID", `Unknown Caplet ID: ${capletId}`);
  if (!caplet.setup || (!caplet.setup.commands?.length && !caplet.setup.verify?.length)) {
    return `No setup metadata is defined for ${caplet.name} (${caplet.server}).\n`;
  }

  const contentHash = capletSetupContentHash(caplet as CapletConfig);
  const store = new LocalSetupStore(options.baseDir ? { baseDir: options.baseDir } : {});
  const existingApproval = await store.getApproval(caplet.server, contentHash, targetKind);
  const actor: SetupActor = options.yes ? "cli-yes" : "cli-interactive";
  if (!existingApproval && !options.yes) {
    return [
      `Setup approval required for ${caplet.name} (${caplet.server}).`,
      `Content hash: ${contentHash}`,
      `Target: ${targetKind}`,
      "",
      "Commands:",
      ...formatCommands(caplet.setup.commands ?? []),
      "Verify:",
      ...formatCommands(caplet.setup.verify ?? []),
      "",
      `Run caplets setup ${caplet.server} --yes to approve and execute these exact steps.`,
      "",
    ].join("\n");
  }

  if (options.yes && !existingApproval) {
    await store.approve({
      capletId: caplet.server,
      contentHash,
      targetKind,
      approvedAt: new Date().toISOString(),
      actor,
    });
  }

  const attempts = await runCapletSetup({
    capletId: caplet.server,
    contentHash,
    targetKind,
    setup: caplet.setup,
    actor,
    approved: true,
    store,
    ...(options.spawn ? { spawn: options.spawn } : {}),
  });
  const failed = attempts.find((attempt) => attempt.status === "failed");
  if (failed) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `Setup failed for ${caplet.server}: ${failed.commandLabel}`,
      { attempts },
    );
  }
  return `Completed setup for ${caplet.name} (${caplet.server}).\n`;
}

function resolveSetupTarget(options: CapletSetupCliOptions): SetupTargetKind {
  if (options.target) return options.target;
  return options.remote ? "remote" : "local";
}

function formatCommands(
  commands: Array<{ label: string; command: string; args?: string[] | undefined }>,
): string[] {
  if (commands.length === 0) return ["  none"];
  return commands.map(
    (command) => `  - ${command.label}: ${[command.command, ...(command.args ?? [])].join(" ")}`,
  );
}
