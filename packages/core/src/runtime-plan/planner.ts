import type { CapletConfig } from "../config-runtime";
import type {
  CapletRuntimePlan,
  RuntimePlanOptions,
  RuntimeRouteKind,
  SetupTargetKind,
} from "./types";
import { inferRuntimeFeatures } from "./features";
import { resolveRuntimeResources } from "./resources";

export function planCapletRuntimeRoutes(
  caplets: Array<CapletConfig | Record<string, unknown>>,
  options: RuntimePlanOptions = {},
): CapletRuntimePlan[] {
  return caplets.map((caplet) => planSingleCaplet(caplet, options));
}

export function planCapletRuntimeRoute(
  caplet: CapletConfig | Record<string, unknown>,
  options: RuntimePlanOptions = {},
): CapletRuntimePlan {
  return planCapletRuntimeRoutes([caplet], options)[0] ?? planSingleCaplet(caplet, options);
}

function planSingleCaplet(
  caplet: CapletConfig | Record<string, unknown>,
  options: RuntimePlanOptions,
): CapletRuntimePlan {
  const route = classifyCapletRuntimeRoute(caplet);
  const setupRequired = Boolean(caplet.setup);
  const projectBindingRequired = projectBindingRequiredFor(caplet);
  const features = inferRuntimeFeatures(caplet);
  const runtime = {
    features: features.features,
    featureProvenance: features.provenance,
    resources: resolveRuntimeResources({
      backend: typeof caplet.backend === "string" ? caplet.backend : undefined,
      features: features.features,
      explicitClass: explicitResourceClass(caplet),
      policy: options.resourcePolicy,
      setupRequired,
    }),
  };
  return {
    id: String(caplet.server ?? ""),
    backend: typeof caplet.backend === "string" ? caplet.backend : "unknown",
    route,
    setupRequired,
    authRequired: authRequired("auth" in caplet ? caplet.auth : undefined),
    ...(route === "process" || route === "project_bound_process"
      ? { setupTarget: setupTargetFor(options.deployment) }
      : {}),
    projectBindingRequired,
    runtime,
    caplet,
  };
}

export function classifyCapletRuntimeRoute(caplet: Record<string, unknown>): RuntimeRouteKind {
  if (projectBindingRequiredFor(caplet)) {
    return "project_bound_process";
  }
  if (caplet.setup) {
    return "process";
  }
  if (caplet.backend === "cli") {
    return "process";
  }
  if (caplet.backend === "mcp") {
    return caplet.transport === "stdio" || Boolean(caplet.command) ? "process" : "worker_safe";
  }
  if (caplet.backend === "openapi" || caplet.backend === "graphql" || caplet.backend === "http") {
    return "worker_safe";
  }
  if (caplet.backend === "caplets") {
    return "worker_safe";
  }
  return "local_only";
}

function setupTargetFor(deployment: RuntimePlanOptions["deployment"]): SetupTargetKind {
  if (deployment === "local") return "local_host";
  return deployment === "self_hosted" ? "remote_host" : "hosted_sandbox";
}

function authRequired(auth: unknown): boolean {
  return auth !== null && typeof auth === "object" && "type" in auth && auth.type !== "none";
}

function projectBindingRequiredFor(caplet: Record<string, unknown>): boolean {
  const projectBinding = caplet.projectBinding;
  return (
    Boolean(projectBinding) &&
    typeof projectBinding === "object" &&
    !Array.isArray(projectBinding) &&
    (projectBinding as { required?: unknown }).required === true
  );
}

function explicitResourceClass(caplet: Record<string, unknown>) {
  const runtime = caplet.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return undefined;
  const resources = (runtime as { resources?: unknown }).resources;
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) return undefined;
  const value = (resources as { class?: unknown }).class;
  return value === "small" ||
    value === "medium" ||
    value === "standard" ||
    value === "large" ||
    value === "heavy"
    ? value
    : undefined;
}
