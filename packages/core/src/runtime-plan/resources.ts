import type {
  RuntimeResourceClass,
  RuntimeResourcePolicy,
  RuntimeResourceResolution,
} from "./types";

const defaults: Record<RuntimeResourceClass, RuntimeResourceResolution> = {
  standard: { class: "standard", cpu: 2, memoryMb: 4096, diskMb: 8192 },
  large: { class: "large", cpu: 4, memoryMb: 8192, diskMb: 20480 },
  heavy: { class: "heavy", cpu: 8, memoryMb: 16384, diskMb: 40960 },
};

const rank: Record<RuntimeResourceClass, number> = {
  standard: 0,
  large: 1,
  heavy: 2,
};

export function resourceClassRank(value: RuntimeResourceClass): number {
  assertRuntimeResourceClass(value, "runtime resource class");
  return rank[value];
}

export function isRuntimeResourceClassAllowed(
  requested: RuntimeResourceClass,
  maximum: RuntimeResourceClass,
): boolean {
  return resourceClassRank(requested) <= resourceClassRank(maximum);
}

type ResourceInput = Record<string, unknown> & {
  backend?: string | undefined;
  features: string[];
  explicitClass?: RuntimeResourceClass | undefined;
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
  const caplet: Record<string, unknown> = inputOrCaplet;
  let input: ResourceInput;
  if (features === undefined) {
    if (!isResourceInput(inputOrCaplet)) {
      throw new TypeError("runtime resource features must be an array of strings");
    }
    input = inputOrCaplet;
  } else {
    input = {
      backend: typeof caplet.backend === "string" ? caplet.backend : undefined,
      features,
      explicitClass: explicitResourceClass(caplet),
      setupRequired: Boolean(caplet.setup),
      policy,
    };
  }
  if (input.explicitClass !== undefined) {
    assertRuntimeResourceClass(input.explicitClass, "runtime resource class");
  }
  if (input.policy?.maxClass !== undefined) {
    assertRuntimeResourceClass(input.policy.maxClass, "runtime resource policy maximum");
  }
  const requested = input.explicitClass ?? defaultResourceClass(input.features);
  let capped = requested;
  if (input.policy?.maxClass && !isRuntimeResourceClassAllowed(requested, input.policy.maxClass)) {
    capped = input.policy.maxClass;
  }
  const resolved = defaults[capped];
  return {
    ...resolved,
    ...(requested !== capped ? { cappedByPolicy: input.policy?.maxClass } : {}),
  };
}

function defaultResourceClass(features: string[]): RuntimeResourceClass {
  const hasDocker = features.includes("docker");
  const hasBrowser = features.includes("browser");
  if (hasDocker && hasBrowser) return "heavy";
  if (hasDocker || hasBrowser) return "large";
  return "standard";
}

function explicitResourceClass(caplet: Record<string, unknown>): RuntimeResourceClass | undefined {
  const runtime = caplet.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return undefined;
  const resources = "resources" in runtime ? runtime.resources : undefined;
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) return undefined;
  const value = "class" in resources ? resources.class : undefined;
  if (value === undefined) return undefined;
  assertRuntimeResourceClass(value, "runtime resource class");
  return value;
}

function isResourceInput(value: Record<string, unknown>): value is ResourceInput {
  return (
    Array.isArray(value.features) && value.features.every((feature) => typeof feature === "string")
  );
}

function assertRuntimeResourceClass(
  value: unknown,
  field: string,
): asserts value is RuntimeResourceClass {
  if (value !== "standard" && value !== "large" && value !== "heavy") {
    throw new TypeError(`${field} must be one of: standard, large, heavy`);
  }
}
