import type { CapletConfig } from "../config";
import { CapletsEngine } from "../engine";
import { CapletsError } from "../errors";
import { capletSetupContentHash } from "../setup/hash";
import { LocalSetupStore } from "../setup/local-store";
import { runCapletSetup } from "../setup/runner";
import type { SetupActor, SetupAttempt, SetupPlan } from "../setup/types";

export type CloudRuntimeAdapterOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  runtimeId: string;
  sandboxId?: string;
  executionKind: "cloud" | "local-fallback";
  setupStore?: LocalSetupStore;
};

export type CloudRuntimeAdapter = {
  listTools(): Promise<unknown>;
  callTool(name: string, args: unknown): Promise<unknown>;
  checkBackend(capletId: string): Promise<unknown>;
  setupPlan(capletId: string): Promise<SetupPlan>;
  runSetup(
    capletId: string,
    input: { approved: boolean; actor: SetupActor },
  ): Promise<SetupAttempt[]>;
  close(): Promise<void>;
};

export function createCloudRuntimeAdapter(
  options: CloudRuntimeAdapterOptions,
): CloudRuntimeAdapter {
  return new DefaultCloudRuntimeAdapter(options);
}

class DefaultCloudRuntimeAdapter implements CloudRuntimeAdapter {
  private readonly engine: CapletsEngine;
  private readonly setupStore: LocalSetupStore;

  constructor(private readonly options: CloudRuntimeAdapterOptions) {
    this.engine = new CapletsEngine({
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.projectConfigPath === undefined
        ? {}
        : { projectConfigPath: options.projectConfigPath }),
      ...(options.authDir === undefined ? {} : { authDir: options.authDir }),
      exposeLocalArtifactPaths: false,
      watch: false,
    });
    this.setupStore = options.setupStore ?? new LocalSetupStore();
  }

  async listTools(): Promise<unknown> {
    return {
      tools: this.enabledCaplets().map((caplet) => ({
        name: caplet.server,
        title: caplet.name,
        description: caplet.description,
        inputSchema: { type: "object", additionalProperties: true },
        _meta: { caplets: { execution: this.executionMetadata() } },
      })),
    };
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const request =
      isRecord(args) && typeof args.operation === "string"
        ? args
        : { operation: "call_tool", name, args: isRecord(args) ? args : {} };
    const result = await this.engine.execute(name, request);
    return annotateExecution(result, this.executionMetadata());
  }

  async checkBackend(capletId: string): Promise<unknown> {
    return annotateExecution(
      await this.engine.execute(capletId, { operation: "check" }),
      this.executionMetadata(),
    );
  }

  async setupPlan(capletId: string): Promise<SetupPlan> {
    const caplet = this.requireCaplet(capletId);
    const contentHash = capletSetupContentHash(caplet);
    const projectFingerprint = "hosted";
    const targetKind = "hosted_sandbox";
    const approved = Boolean(
      await this.setupStore.getApproval(projectFingerprint, capletId, contentHash, targetKind),
    );
    return {
      projectFingerprint,
      capletId,
      name: caplet.name,
      contentHash,
      targetKind,
      setup: caplet.setup ?? {},
      approved,
      commands: caplet.setup?.commands ?? [],
      verify: caplet.setup?.verify ?? [],
    };
  }

  async runSetup(
    capletId: string,
    input: { approved: boolean; actor: SetupActor },
  ): Promise<SetupAttempt[]> {
    const plan = await this.setupPlan(capletId);
    if (input.approved && !plan.approved) {
      await this.setupStore.approve({
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
      targetKind: plan.targetKind,
      setup: plan.setup,
      actor: input.actor,
      approved: input.approved || plan.approved,
      store: this.setupStore,
    });
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

  private requireCaplet(capletId: string): CapletConfig {
    const caplet = this.enabledCaplets().find((entry) => entry.server === capletId);
    if (!caplet) throw new CapletsError("CONFIG_INVALID", `Unknown Caplet ID: ${capletId}`);
    return caplet;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
