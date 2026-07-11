import type { Prompt, Resource, ResourceTemplate, Tool } from "@modelcontextprotocol/sdk/types";
import type { CapletConfig, CapletsConfig } from "../config";
import { toSafeError, type SafeErrorSummary } from "../errors";
import {
  projectBindingHiddenDiagnostic,
  projectBindingMissingContextDiagnostic,
} from "../project-binding/errors";
import type { ProjectBindingExecutionContext } from "../project-binding/execution-context";
import type { ProjectBindingQuarantineRecord } from "../project-binding/types";
import { resolveExposure, type ResolvedExposure } from "./policy";

export type HiddenCapletReason =
  | "disabled"
  | "setup_required"
  | "project_binding_required"
  | "project_binding_missing_context"
  | "project_binding_unsupported"
  | "project_binding_auth_failed"
  | "project_binding_metadata_unknown"
  | "project_binding_sync_failed"
  | "project_binding_retry_exhausted"
  | "project_binding_quarantined"
  | "project_binding_invalid_cwd"
  | "project_binding_policy_denied"
  | "discovery_failed"
  | "empty_surface";

export type HiddenCaplet = {
  capletId: string;
  reason: HiddenCapletReason;
  error?: SafeErrorSummary | undefined;
};

export type CallableCaplet = {
  caplet: CapletConfig;
  exposure: ResolvedExposure;
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  prompts: Prompt[];
  completions: boolean;
  discoveredAt: number;
};

export type ExposureSnapshot = {
  callableCaplets: CallableCaplet[];
  hiddenCaplets: HiddenCaplet[];
};

export type DiscoverExposureSnapshotOptions = {
  config: CapletsConfig;
  caplets: CapletConfig[];
  discoverNonDirectMcpSurfaces?: boolean | undefined;
  projectBindingContext?: ProjectBindingExecutionContext | undefined;
  listTools(caplet: CapletConfig): Promise<Tool[]>;
  listResources?(caplet: Extract<CapletConfig, { backend: "mcp" }>): Promise<Resource[]>;
  listResourceTemplates?(
    caplet: Extract<CapletConfig, { backend: "mcp" }>,
  ): Promise<ResourceTemplate[]>;
  listPrompts?(caplet: Extract<CapletConfig, { backend: "mcp" }>): Promise<Prompt[]>;
  supportsCompletions?(caplet: Extract<CapletConfig, { backend: "mcp" }>): Promise<boolean>;
};

export async function discoverExposureSnapshot(
  options: DiscoverExposureSnapshotOptions,
): Promise<ExposureSnapshot> {
  const results = await mapWithConcurrency(
    options.caplets,
    Math.max(1, Math.min(32, options.config.options.exposureDiscoveryConcurrency)),
    async (caplet) => discoverCaplet(options, caplet),
  );

  return {
    callableCaplets: results.flatMap((result) => (result.callable ? [result.callable] : [])),
    hiddenCaplets: results.flatMap((result) => (result.hidden ? [result.hidden] : [])),
  };
}

async function discoverCaplet(
  options: DiscoverExposureSnapshotOptions,
  caplet: CapletConfig,
): Promise<{ callable?: CallableCaplet; hidden?: HiddenCaplet }> {
  if (caplet.disabled) return { hidden: { capletId: caplet.server, reason: "disabled" } };
  if (caplet.setup) return { hidden: { capletId: caplet.server, reason: "setup_required" } };
  if (caplet.projectBinding?.required && !options.projectBindingContext) {
    return {
      hidden: {
        capletId: caplet.server,
        reason: "project_binding_missing_context",
        error: projectBindingMissingContextDiagnostic(),
      },
    };
  }
  const quarantineRecord = options.projectBindingContext?.quarantineRecords?.find(
    (record) => record.capletId === caplet.server,
  );
  if (quarantineRecord) {
    return {
      hidden: {
        capletId: caplet.server,
        reason: hiddenReasonForQuarantine(quarantineRecord),
        error: diagnosticForQuarantine(quarantineRecord),
      },
    };
  }

  const exposure = resolveExposure(caplet.exposure, options.config.options.exposure);
  if (
    !exposure.direct &&
    caplet.backend === "mcp" &&
    options.discoverNonDirectMcpSurfaces === false
  ) {
    return {
      callable: {
        caplet,
        exposure,
        tools: [],
        resources: [],
        resourceTemplates: [],
        prompts: [],
        completions: false,
        discoveredAt: Date.now(),
      },
    };
  }
  try {
    const tools = await withTimeout(
      options.listTools(caplet),
      options.config.options.exposureDiscoveryTimeoutMs,
    );
    const resources =
      caplet.backend === "mcp" && options.listResources
        ? await withTimeout(
            options.listResources(caplet),
            options.config.options.exposureDiscoveryTimeoutMs,
          )
        : [];
    const resourceTemplates =
      caplet.backend === "mcp" && options.listResourceTemplates
        ? await withTimeout(
            options.listResourceTemplates(caplet),
            options.config.options.exposureDiscoveryTimeoutMs,
          )
        : [];
    const prompts =
      caplet.backend === "mcp" && options.listPrompts
        ? await withTimeout(
            options.listPrompts(caplet),
            options.config.options.exposureDiscoveryTimeoutMs,
          )
        : [];
    const completions =
      caplet.backend === "mcp" && options.supportsCompletions
        ? await withTimeout(
            options.supportsCompletions(caplet),
            options.config.options.exposureDiscoveryTimeoutMs,
          )
        : false;
    if (
      tools.length === 0 &&
      resources.length === 0 &&
      resourceTemplates.length === 0 &&
      prompts.length === 0
    ) {
      return { hidden: { capletId: caplet.server, reason: "empty_surface" } };
    }
    return {
      callable: {
        caplet,
        exposure,
        tools,
        resources,
        resourceTemplates,
        prompts,
        completions,
        discoveredAt: Date.now(),
      },
    };
  } catch (error) {
    return {
      hidden: {
        capletId: caplet.server,
        reason: "discovery_failed",
        error: toSafeError(error, "SERVER_UNAVAILABLE"),
      },
    };
  }
}

function hiddenReasonForQuarantine(record: ProjectBindingQuarantineRecord): HiddenCapletReason {
  switch (record.reason) {
    case "sync_failed":
      return "project_binding_sync_failed";
    case "retry_exhausted":
      return "project_binding_retry_exhausted";
    case "invalid_cwd":
      return "project_binding_invalid_cwd";
    case "policy_denied":
      return "project_binding_policy_denied";
    case "binding_unsupported":
      return "project_binding_unsupported";
    case "auth_trust_failed":
      return "project_binding_auth_failed";
    case "metadata_unknown":
      return "project_binding_metadata_unknown";
    case "missing_context":
      return "project_binding_missing_context";
    case "quarantined":
      return "project_binding_quarantined";
  }
}

function diagnosticForQuarantine(record: ProjectBindingQuarantineRecord): SafeErrorSummary {
  return projectBindingHiddenDiagnostic({
    reason: record.reason,
    message: record.message,
    recoveryCommand: record.recoveryCommand,
    requestId: record.requestId,
    details: {
      capletId: record.capletId,
      ...(record.code === undefined ? {} : { diagnosticCode: record.code }),
      ...(record.upstreamId === undefined ? {} : { upstreamId: record.upstreamId }),
      ...(record.recordedAt === undefined ? {} : { recordedAt: record.recordedAt }),
      ...(record.retry === undefined ? {} : { retry: record.retry }),
      ...(record.sync === undefined ? {} : { sync: record.sync }),
    },
  });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= values.length) return;
      results[current] = await mapper(values[current]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Exposure discovery timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
