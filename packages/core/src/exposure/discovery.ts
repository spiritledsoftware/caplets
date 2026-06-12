import type { Prompt, Resource, ResourceTemplate, Tool } from "@modelcontextprotocol/sdk/types";
import type { CapletConfig, CapletsConfig } from "../config";
import { toSafeError, type SafeErrorSummary } from "../errors";
import {
  directPromptName,
  directResourceTemplateUri,
  directResourceUri,
  directToolName,
} from "./direct-names";
import { resolveExposure, type ResolvedExposure } from "./policy";

export type HiddenCapletReason =
  | "disabled"
  | "setup_required"
  | "project_binding_required"
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
  discoveredAt: number;
};

export type DirectToolRegistration = {
  caplet: CapletConfig;
  downstreamName: string;
  name: string;
  tool: Tool;
};

export type DirectResourceRegistration = {
  caplet: Extract<CapletConfig, { backend: "mcp" }>;
  downstreamUri: string;
  uri: string;
  resource: Resource;
};

export type DirectResourceTemplateRegistration = {
  caplet: Extract<CapletConfig, { backend: "mcp" }>;
  downstreamUriTemplate: string;
  uriTemplate: string;
  resourceTemplate: ResourceTemplate;
};

export type DirectPromptRegistration = {
  caplet: Extract<CapletConfig, { backend: "mcp" }>;
  downstreamName: string;
  name: string;
  prompt: Prompt;
};

export type ExposureSnapshot = {
  callableCaplets: CallableCaplet[];
  progressiveCaplets: CallableCaplet[];
  codeModeCaplets: CallableCaplet[];
  directTools: DirectToolRegistration[];
  directResources: DirectResourceRegistration[];
  directResourceTemplates: DirectResourceTemplateRegistration[];
  directPrompts: DirectPromptRegistration[];
  hiddenCaplets: HiddenCaplet[];
};

export type DiscoverExposureSnapshotOptions = {
  config: CapletsConfig;
  caplets: CapletConfig[];
  discoverNonDirectMcpSurfaces?: boolean | undefined;
  listTools(caplet: CapletConfig): Promise<Tool[]>;
  listResources?(caplet: Extract<CapletConfig, { backend: "mcp" }>): Promise<Resource[]>;
  listResourceTemplates?(
    caplet: Extract<CapletConfig, { backend: "mcp" }>,
  ): Promise<ResourceTemplate[]>;
  listPrompts?(caplet: Extract<CapletConfig, { backend: "mcp" }>): Promise<Prompt[]>;
};

export async function discoverExposureSnapshot(
  options: DiscoverExposureSnapshotOptions,
): Promise<ExposureSnapshot> {
  const results = await mapWithConcurrency(
    options.caplets,
    Math.max(1, Math.min(32, options.config.options.exposureDiscoveryConcurrency)),
    async (caplet) => discoverCaplet(options, caplet),
  );

  const callableCaplets = results.flatMap((result) => (result.callable ? [result.callable] : []));
  const hiddenCaplets = results.flatMap((result) => (result.hidden ? [result.hidden] : []));
  return {
    callableCaplets,
    progressiveCaplets: callableCaplets.filter((entry) => entry.exposure.progressive),
    codeModeCaplets: callableCaplets.filter((entry) => entry.exposure.codeMode),
    directTools: callableCaplets.flatMap((entry) =>
      entry.exposure.direct
        ? entry.tools.map((tool) => ({
            caplet: entry.caplet,
            downstreamName: tool.name,
            name: directToolName(entry.caplet.server, tool.name),
            tool,
          }))
        : [],
    ),
    directResources: callableCaplets.flatMap(directResourcesFor),
    directResourceTemplates: callableCaplets.flatMap(directResourceTemplatesFor),
    directPrompts: callableCaplets.flatMap(directPromptsFor),
    hiddenCaplets,
  };
}

function directResourcesFor(entry: CallableCaplet): DirectResourceRegistration[] {
  if (!entry.exposure.direct || !isMcpCaplet(entry.caplet)) return [];
  const caplet = entry.caplet;
  return entry.resources.map((resource) => ({
    caplet,
    downstreamUri: resource.uri,
    uri: directResourceUri(caplet.server, resource.uri),
    resource,
  }));
}

function directResourceTemplatesFor(entry: CallableCaplet): DirectResourceTemplateRegistration[] {
  if (!entry.exposure.direct || !isMcpCaplet(entry.caplet)) return [];
  const caplet = entry.caplet;
  return entry.resourceTemplates.map((resourceTemplate) => ({
    caplet,
    downstreamUriTemplate: resourceTemplate.uriTemplate,
    uriTemplate: directResourceTemplateUri(caplet.server, resourceTemplate.uriTemplate),
    resourceTemplate,
  }));
}

function directPromptsFor(entry: CallableCaplet): DirectPromptRegistration[] {
  if (!entry.exposure.direct || !isMcpCaplet(entry.caplet)) return [];
  const caplet = entry.caplet;
  return entry.prompts.map((prompt) => ({
    caplet,
    downstreamName: prompt.name,
    name: directPromptName(caplet.server, prompt.name),
    prompt,
  }));
}

function isMcpCaplet(caplet: CapletConfig): caplet is Extract<CapletConfig, { backend: "mcp" }> {
  return caplet.backend === "mcp";
}

async function discoverCaplet(
  options: DiscoverExposureSnapshotOptions,
  caplet: CapletConfig,
): Promise<{ callable?: CallableCaplet; hidden?: HiddenCaplet }> {
  if (caplet.disabled) return { hidden: { capletId: caplet.server, reason: "disabled" } };
  if (caplet.setup) return { hidden: { capletId: caplet.server, reason: "setup_required" } };
  if (caplet.projectBinding?.required) {
    return { hidden: { capletId: caplet.server, reason: "project_binding_required" } };
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
