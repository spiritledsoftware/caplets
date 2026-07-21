import {
  loadConfigWithHostStorage,
  loadHostStorageConfig,
  resolveConfigPath,
  resolveProjectConfigPath,
} from "../config";
import { CapletsError } from "../errors";
import { capletSetupContentHash } from "../setup/hash";
import { runCapletSetup, type SetupSpawn } from "../setup/runner";
import { createHostStorage, createHostStorageVaultResolver, type HostStorage } from "../storage";
import { isSetupTargetKind, type SetupActor, type SetupTargetKind } from "../setup/types";

export type CapletSetupCliOptions = {
  yes?: boolean;
  target?: SetupTargetKind;
  remote?: boolean;
  configPath?: string | undefined;
  projectConfigPath?: string | undefined;
  hostStorage?: HostStorage | undefined;
  spawn?: SetupSpawn;
};

export async function runCapletSetupCli(
  capletId: string,
  options: CapletSetupCliOptions = {},
): Promise<string> {
  const targetKind = resolveSetupTarget(options);
  const configPath = options.configPath ?? resolveConfigPath();
  const projectConfigPath = options.projectConfigPath ?? resolveProjectConfigPath();
  const storage =
    options.hostStorage ?? (await createHostStorage(loadHostStorageConfig(configPath)));
  const ownsStorage = options.hostStorage === undefined;
  try {
    const loaded = await loadConfigWithHostStorage(storage, configPath, projectConfigPath, {
      vaultResolver: await createHostStorageVaultResolver(storage),
    });
    const config = loaded.config;
    const caplet = Object.values({
      ...config.mcpServers,
      ...config.openapiEndpoints,
      ...config.googleDiscoveryApis,
      ...config.graphqlEndpoints,
      ...config.httpApis,
      ...config.cliTools,
      ...config.capletSets,
    }).find((entry) => entry.server === capletId);
    if (!caplet) throw new CapletsError("CONFIG_INVALID", `Unknown Caplet ID: ${capletId}`);
    if (!caplet.setup || (!caplet.setup.commands?.length && !caplet.setup.verify?.length)) {
      return `No setup metadata is defined for ${caplet.name} (${caplet.server}).\n`;
    }

    const runtimeFingerprint = loaded.runtimeFingerprint?.caplets[caplet.server];
    const contentHash = capletSetupContentHash(runtimeFingerprint);
    const projectFingerprint = "default";
    const store = storage.setupState;
    const existingApproval =
      runtimeFingerprint?.persistenceEligible === false
        ? undefined
        : await store.getApproval(projectFingerprint, caplet.server, contentHash, targetKind);
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

    if (options.yes && !existingApproval && runtimeFingerprint?.persistenceEligible !== false) {
      await store.approve(
        {
          projectFingerprint,
          capletId: caplet.server,
          contentHash,
          targetKind,
          approvedAt: new Date().toISOString(),
          actor,
        },
        { operatorClientId: "local_cli" },
      );
    }

    const attempts = await runCapletSetup({
      projectFingerprint,
      capletId: caplet.server,
      contentHash,
      targetKind,
      setup: caplet.setup,
      actor,
      approved: true,
      store,
      operatorClientId: "local_cli",
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
  } finally {
    if (ownsStorage) await storage.close();
  }
}

function resolveSetupTarget(options: CapletSetupCliOptions): SetupTargetKind {
  if (options.target !== undefined && !isSetupTargetKind(options.target)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "setup target must be one of: local_host, remote_host",
    );
  }
  if (options.target) return options.target;
  return options.remote ? "remote_host" : "local_host";
}

function formatCommands(
  commands: Array<{ label: string; command: string; args?: string[] | undefined }>,
): string[] {
  if (commands.length === 0) return ["  none"];
  return commands.map(
    (command) => `  - ${command.label}: ${[command.command, ...(command.args ?? [])].join(" ")}`,
  );
}
