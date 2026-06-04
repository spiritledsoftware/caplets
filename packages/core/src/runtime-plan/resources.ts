import type {
  HostedRuntimeResourceClass,
  RuntimeResourcePolicy,
  RuntimeResourceResolution,
} from "./types";

const defaults: Record<string, RuntimeResourceResolution> = {
  small: { class: "small", cpu: 1, memoryMb: 1024, diskMb: 4096 },
  medium: { class: "medium", cpu: 2, memoryMb: 4096, diskMb: 8192 },
  standard: { class: "standard", cpu: 2, memoryMb: 4096, diskMb: 8192 },
  large: { class: "large", cpu: 4, memoryMb: 8192, diskMb: 20480 },
  heavy: { class: "heavy", cpu: 8, memoryMb: 16384, diskMb: 40960 },
};

const rank: Record<string, number> = {
  small: 0,
  standard: 1,
  medium: 1,
  large: 2,
  heavy: 3,
};

type ResourceInput = {
  backend?: string | undefined;
  features: string[];
  explicitClass?: HostedRuntimeResourceClass | undefined;
  setupRequired?: boolean | undefined;
  policy?: RuntimeResourcePolicy | undefined;
};

export function resolveRuntimeResources(input: ResourceInput): RuntimeResourceResolution;
export function resolveRuntimeResources(
  caplet: Record<string, unknown>,
  features: string[],
  policy?: RuntimeResourcePolicy | undefined,
): RuntimeResourceResolution;
export function resolveRuntimeResources(
  inputOrCaplet: ResourceInput | Record<string, unknown>,
  features?: string[],
  policy?: RuntimeResourcePolicy | undefined,
): RuntimeResourceResolution {
  const caplet = inputOrCaplet as Record<string, unknown>;
  const input =
    features === undefined
      ? (inputOrCaplet as ResourceInput)
      : {
          backend: typeof caplet.backend === "string" ? caplet.backend : undefined,
          features,
          explicitClass: explicitResourceClass(caplet),
          setupRequired: Boolean(caplet.setup),
          policy,
        };
  const requested = input.explicitClass ?? defaultResourceClass(input);
  const capped = capClass(requested, input.policy?.maxClass);
  const resolved = defaults[capped] ?? defaults.standard!;
  return {
    ...resolved,
    ...(requested !== capped ? { cappedByPolicy: input.policy?.maxClass } : {}),
  };
}

function defaultResourceClass(input: ResourceInput): HostedRuntimeResourceClass {
  const hasDocker = input.features.includes("docker");
  const hasBrowser = input.features.includes("browser");
  if (hasDocker && hasBrowser) return "heavy";
  if (hasDocker || hasBrowser) return "large";
  if (input.backend === "cli" || input.backend === "mcp" || input.setupRequired) return "medium";
  return "small";
}

function explicitResourceClass(
  caplet: Record<string, unknown>,
): HostedRuntimeResourceClass | undefined {
  const runtime = caplet.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return undefined;
  const resources = (runtime as { resources?: unknown }).resources;
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) return undefined;
  const value = (resources as { class?: unknown }).class;
  return typeof value === "string" ? (value as HostedRuntimeResourceClass) : undefined;
}

function capClass(
  requested: HostedRuntimeResourceClass,
  maxClass: HostedRuntimeResourceClass | undefined,
) {
  if (!maxClass) return requested;
  return (rank[requested] ?? 0) > (rank[maxClass] ?? 0) ? maxClass : requested;
}
