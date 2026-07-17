import {
  loadConfigWithSources,
  resolveConfigPath,
  resolveProjectConfigPath,
  runtimeFingerprintForConfig,
} from "../config";
import { createCapletsEngine } from "../engine";
import { CapletsError } from "../errors";
import { capletSetupContentHash } from "../setup/hash";
import { LocalSetupStore, type SetupSnapshotToken, type SetupStore } from "../setup/local-store";
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
  env?: NodeJS.ProcessEnv | undefined;
};

export async function runCapletSetupCli(
  capletId: string,
  options: CapletSetupCliOptions = {},
): Promise<string> {
  const targetKind = resolveSetupTarget(options);
  if (targetKind === "hosted_sandbox") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Cloud setup runs through the Caplets Cloud API, not the local CLI runner",
    );
  }

  const configPath = options.configPath ?? resolveConfigPath();
  const projectConfigPath = options.projectConfigPath ?? resolveProjectConfigPath();
  const context = await openSetupContext(options, configPath, projectConfigPath);
  try {
    const config = context.config;
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

    const runtimeFingerprint = context.runtimeFingerprint.caplets[caplet.server];
    const contentHash = capletSetupContentHash(runtimeFingerprint);
    const projectFingerprint = "default";
    const existingApproval =
      runtimeFingerprint?.persistenceEligible === false
        ? undefined
        : await context.store.getApproval(
            projectFingerprint,
            caplet.server,
            contentHash,
            targetKind,
          );
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
      await context.store.approve({
        projectFingerprint,
        capletId: caplet.server,
        contentHash,
        targetKind,
        approvedAt: new Date().toISOString(),
        actor,
      });
    }

    const attempts = await runCapletSetup({
      projectFingerprint,
      capletId: caplet.server,
      contentHash,
      snapshotToken: context.snapshotToken,
      setupHash: contentHash,
      targetKind,
      setup: caplet.setup,
      actor,
      approved: true,
      store: context.store,
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
    await context.close();
  }
}

async function openSetupContext(
  options: CapletSetupCliOptions,
  configPath: string,
  projectConfigPath: string,
): Promise<{
  store: SetupStore;
  config: ReturnType<typeof loadConfigWithSources>["config"];
  runtimeFingerprint: ReturnType<typeof runtimeFingerprintForConfig>;
  close: () => Promise<void>;
  snapshotToken?: SetupSnapshotToken | undefined;
}> {
  // Explicit baseDir is an internal test seam for the pre-activation filesystem contract.
  if (options.baseDir) {
    const loaded = loadConfigWithSources(configPath, projectConfigPath);
    return {
      store: new LocalSetupStore({ baseDir: options.baseDir }),
      config: loaded.config,
      runtimeFingerprint: loaded.runtimeFingerprint ?? runtimeFingerprintForConfig(loaded.config),
      close: async () => undefined,
    };
  }
  const engine = await createCapletsEngine({
    configPath,
    projectConfigPath,
    watch: false,
    env: options.env,
  });
  try {
    await engine.requireLiveControlPlane("admin");
    const store = engine.controlPlaneSecurityRepository();
    if (!store) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Setup persistence is unavailable until SQL activation completes.",
      );
    }
    const snapshot = engine.currentControlPlaneRuntimeSnapshot();
    if (!snapshot) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Setup configuration is unavailable until SQL activation completes.",
      );
    }
    return {
      store,
      config: snapshot.config,
      runtimeFingerprint:
        snapshot.configWithSources.runtimeFingerprint ??
        runtimeFingerprintForConfig(snapshot.config),
      close: () => engine.close(),
      snapshotToken: {
        authorityGeneration: snapshot.authorityGeneration,
        effectiveGeneration: snapshot.effectiveGeneration,
        securityEpoch: snapshot.securityEpoch,
      },
    };
  } catch (error) {
    await engine.close();
    throw error;
  }
}

function resolveSetupTarget(options: CapletSetupCliOptions): SetupTargetKind {
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
