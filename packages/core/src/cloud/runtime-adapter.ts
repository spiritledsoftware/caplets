import { runtimeFingerprintForConfig, type CapletConfig, type CapletSetupConfig } from "../config";
import {
  CapletsEngine,
  createCapletsEngine,
  createInternalCapletsEngine,
  type CapletsEngineOptions,
} from "../engine";
import { CapletsError } from "../errors";
import type { ControlPlaneRuntimeSnapshotLoader } from "../control-plane/snapshot";
import type {
  ActivatedControlPlaneRead,
  ControlPlaneLiveOperationClass,
  ControlPlaneStaleReadClass,
} from "../control-plane/service";
import type { ControlPlaneHealthSummary } from "../control-plane/types";
import { capletSetupContentHash } from "../setup/hash";
import type { SetupSnapshotToken, SetupStore } from "../setup/local-store";
import { runCapletSetup } from "../setup/runner";
import type { SetupActor, SetupAttempt, SetupPlan } from "../setup/types";

export type CloudRuntimeAdapterOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  runtimeId: string;
  sandboxId?: string;
  executionKind: "cloud" | "local-fallback";
};

export type CloudRuntimeAdapter = {
  listTools(): Promise<unknown>;
  health(): Promise<ControlPlaneHealthSummary | undefined>;
  callTool(name: string, args: unknown): Promise<unknown>;
  checkBackend(capletId: string): Promise<unknown>;
  setupPlan(capletId: string): Promise<SetupPlan>;
  runSetup(
    capletId: string,
    input: { approved: boolean; actor: SetupActor },
  ): Promise<SetupAttempt[]>;
  close(): Promise<void>;
};
type InternalCloudRuntimeActivation = Readonly<{
  requireLive?: ((operation: ControlPlaneLiveOperationClass) => Promise<unknown>) | undefined;
  read?: ((operation: ControlPlaneStaleReadClass) => ActivatedControlPlaneRead) | undefined;
  security?:
    | import("../control-plane/security/repository").ControlPlaneSecurityRepository
    | undefined;
}>;

export async function createCloudRuntimeAdapter(
  options: CloudRuntimeAdapterOptions,
): Promise<CloudRuntimeAdapter> {
  const engine = await createCapletsEngine(cloudEngineOptions(options));
  return new DefaultCloudRuntimeAdapter(options, engine);
}

export async function createInternalCloudRuntimeAdapter(
  options: CloudRuntimeAdapterOptions,
  loader: ControlPlaneRuntimeSnapshotLoader,
  activation: InternalCloudRuntimeActivation = {},
): Promise<CloudRuntimeAdapter> {
  const engine = await createInternalCapletsEngine(
    cloudEngineOptions(options),
    loader,
    undefined,
    undefined,
    undefined,
    undefined,
    activation.requireLive,
    activation.security,
    undefined,
    undefined,
    activation.read,
  );
  return new DefaultCloudRuntimeAdapter(options, engine);
}

class DefaultCloudRuntimeAdapter implements CloudRuntimeAdapter {
  private readonly engine: CapletsEngine;

  constructor(
    private readonly options: CloudRuntimeAdapterOptions,
    engine: CapletsEngine,
  ) {
    this.engine = engine;
  }

  health(): Promise<ControlPlaneHealthSummary | undefined> {
    return this.engine.controlPlaneHealth();
  }

  async listTools(): Promise<unknown> {
    const availability = this.engine.controlPlaneRead("runtime-metadata-read");
    const metadata = {
      execution: this.executionMetadata(),
      ...(availability
        ? {
            availability: {
              stale: availability.stale,
              ...(availability.staleAgeMs === undefined
                ? {}
                : { staleAgeMs: availability.staleAgeMs }),
            },
          }
        : {}),
    };
    return {
      tools: this.enabledCaplets().map((caplet) => ({
        name: caplet.server,
        title: caplet.name,
        description: caplet.description,
        inputSchema: { type: "object", additionalProperties: true },
        _meta: { caplets: metadata },
      })),
      _meta: { caplets: metadata },
    };
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    await this.engine.requireLiveControlPlane("mutation");
    const request =
      isRecord(args) && typeof args.operation === "string"
        ? args
        : { operation: "call_tool", name, args: isRecord(args) ? args : {} };
    const result = await this.engine.execute(name, request);
    return annotateExecution(result, this.executionMetadata());
  }

  async checkBackend(capletId: string): Promise<unknown> {
    await this.engine.requireLiveControlPlane("mutation");
    return annotateExecution(
      await this.engine.execute(capletId, { operation: "check" }),
      this.executionMetadata(),
    );
  }

  async setupPlan(capletId: string): Promise<SetupPlan> {
    await this.engine.requireLiveControlPlane("admin");
    return (await this.prepareSetup(capletId)).plan;
  }

  async runSetup(
    capletId: string,
    input: { approved: boolean; actor: SetupActor },
  ): Promise<SetupAttempt[]> {
    await this.engine.requireLiveControlPlane("mutation");
    const prepared = await this.prepareSetup(capletId);
    const { plan } = prepared;
    const setupStore = this.requireSetupStore();
    if (input.approved && !plan.approved && plan.persistenceEligible) {
      await setupStore.approve({
        projectFingerprint: plan.projectFingerprint,
        capletId,
        contentHash: plan.contentHash,
        targetKind: plan.targetKind,
        actor: input.actor,
        approvedAt: new Date().toISOString(),
      });
    }
    return await runCapletSetup({
      capletId,
      projectFingerprint: plan.projectFingerprint,
      contentHash: plan.contentHash,
      setupHash: plan.contentHash,
      snapshotToken: prepared.snapshotToken,
      targetKind: plan.targetKind,
      setup: prepared.setup,
      actor: input.actor,
      approved: input.approved || plan.approved,
      store: setupStore,
    });
  }

  private async prepareSetup(capletId: string): Promise<{
    plan: SetupPlan;
    setup: CapletSetupConfig;
    snapshotToken: SetupSnapshotToken;
  }> {
    const snapshot = this.engine.currentControlPlaneRuntimeSnapshot();
    if (!snapshot) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Cloud setup configuration is unavailable until SQL activation completes.",
      );
    }
    const caplet = Object.values({
      ...snapshot.config.mcpServers,
      ...snapshot.config.openapiEndpoints,
      ...snapshot.config.googleDiscoveryApis,
      ...snapshot.config.graphqlEndpoints,
      ...snapshot.config.httpApis,
      ...snapshot.config.cliTools,
      ...snapshot.config.capletSets,
    }).find((entry) => entry.server === capletId);
    if (!caplet || caplet.disabled) {
      throw new CapletsError("CONFIG_INVALID", `Unknown Caplet ID: ${capletId}`);
    }
    const runtimeFingerprint =
      snapshot.configWithSources.runtimeFingerprint?.caplets[capletId] ??
      runtimeFingerprintForConfig(snapshot.config).caplets[capletId];
    const contentHash = capletSetupContentHash(runtimeFingerprint);
    const setupStore = this.requireSetupStore();
    const projectFingerprint = "hosted";
    const targetKind = "hosted_sandbox";
    const approved =
      runtimeFingerprint?.persistenceEligible === false
        ? false
        : Boolean(
            await setupStore.getApproval(projectFingerprint, capletId, contentHash, targetKind),
          );
    const setup = caplet.setup ?? {};
    const publicSetup = redactSetupConfig(setup);
    return {
      plan: {
        projectFingerprint,
        capletId,
        name: caplet.name,
        contentHash,
        targetKind,
        setup: publicSetup,
        approved,
        persistenceEligible: runtimeFingerprint?.persistenceEligible ?? true,
        commands: publicSetup.commands ?? [],
        verify: publicSetup.verify ?? [],
      },
      setup,
      snapshotToken: {
        authorityGeneration: snapshot.authorityGeneration,
        effectiveGeneration: snapshot.effectiveGeneration,
        securityEpoch: snapshot.securityEpoch,
      },
    };
  }

  async close(): Promise<void> {
    await this.engine.close();
  }

  private enabledCaplets(): CapletConfig[] {
    return Object.values({
      ...this.engine.currentConfig().mcpServers,
      ...this.engine.currentConfig().openapiEndpoints,
      ...this.engine.currentConfig().googleDiscoveryApis,
      ...this.engine.currentConfig().graphqlEndpoints,
      ...this.engine.currentConfig().httpApis,
      ...this.engine.currentConfig().cliTools,
      ...this.engine.currentConfig().capletSets,
    }).filter((caplet) => !caplet.disabled);
  }

  private requireSetupStore(): SetupStore {
    const repository = this.engine.controlPlaneSecurityRepository();
    if (!repository) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Cloud setup persistence is unavailable until SQL activation completes.",
      );
    }
    return repository;
  }

  private executionMetadata() {
    return {
      kind: this.options.executionKind,
      runtimeId: this.options.runtimeId,
      ...(this.options.sandboxId ? { sandboxId: this.options.sandboxId } : {}),
      ...(this.options.executionKind === "local-fallback" ? { fallback: true } : {}),
    };
  }
}

function cloudEngineOptions(options: CloudRuntimeAdapterOptions): CapletsEngineOptions {
  return {
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.projectConfigPath === undefined
      ? {}
      : { projectConfigPath: options.projectConfigPath }),
    ...(options.authDir === undefined ? {} : { authDir: options.authDir }),
    exposeLocalArtifactPaths: false,
    watch: false,
  };
}

function annotateExecution(result: unknown, execution: Record<string, unknown>): unknown {
  if (!isRecord(result)) return result;
  const meta = isRecord(result._meta) ? result._meta : {};
  const caplets = isRecord(meta.caplets) ? meta.caplets : {};
  return {
    ...result,
    _meta: {
      ...meta,
      caplets: {
        ...caplets,
        execution,
      },
    },
  };
}

function redactSetupConfig(setup: CapletSetupConfig): CapletSetupConfig {
  const redactCommands = (commands: CapletSetupConfig["commands"]) =>
    commands?.map((command) => ({
      ...command,
      ...(command.args ? { args: command.args.map(() => "[REDACTED]") } : {}),
      ...(command.env
        ? { env: Object.fromEntries(Object.keys(command.env).map((key) => [key, "[REDACTED]"])) }
        : {}),
    }));
  return {
    ...setup,
    ...(setup.commands ? { commands: redactCommands(setup.commands) } : {}),
    ...(setup.verify ? { verify: redactCommands(setup.verify) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
