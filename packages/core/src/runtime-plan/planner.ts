import type { CapletConfig } from "../config-runtime";
import type {
  CapletRuntimePlan,
  RuntimePlanDeployment,
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
  assertRuntimePlanDeployment(options.deployment);
  return caplets.map((caplet) => planSingleCaplet(caplet, options));
}

export function planCapletRuntimeRoute(
  caplet: CapletConfig | Record<string, unknown>,
  options: RuntimePlanOptions = {},
): CapletRuntimePlan {
  assertRuntimePlanDeployment(options.deployment);
  return planSingleCaplet(caplet, options);
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
    resources: resolveRuntimeResources(caplet, features.features, options.resourcePolicy),
  };
  return {
    id: String(caplet.server ?? ""),
    backend: typeof caplet.backend === "string" ? caplet.backend : "unknown",
    route,
    setupRequired,
    authRequired: authRequired("auth" in caplet ? caplet.auth : undefined),
    ...(options.deployment !== undefined &&
    (route === "process" || route === "project_bound_process")
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
  if (
    caplet.backend === "openapi" ||
    caplet.backend === "googleDiscovery" ||
    caplet.backend === "graphql" ||
    caplet.backend === "http"
  ) {
    return "worker_safe";
  }
  if (caplet.backend === "caplets") {
    return "worker_safe";
  }
  return "local_only";
}

function assertRuntimePlanDeployment(
  value: unknown,
): asserts value is RuntimePlanDeployment | undefined {
  if (value !== undefined && value !== "local" && value !== "remote") {
    throw new TypeError("runtime deployment must be one of: local, remote");
  }
}

function setupTargetFor(deployment: RuntimePlanDeployment): SetupTargetKind {
  return deployment === "local" ? "local_host" : "remote_host";
}

function authRequired(auth: unknown): boolean {
  return auth !== null && typeof auth === "object" && "type" in auth && auth.type !== "none";
}

function projectBindingRequiredFor(caplet: Record<string, unknown>): boolean {
  const projectBinding = caplet.projectBinding;
  return (
    projectBinding !== null &&
    typeof projectBinding === "object" &&
    !Array.isArray(projectBinding) &&
    "required" in projectBinding &&
    projectBinding.required === true
  );
}
