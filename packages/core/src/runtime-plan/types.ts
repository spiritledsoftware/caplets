import type { CapletConfig, RuntimeFeature, RuntimeResourceClass } from "../config-runtime";

export type { RuntimeFeature, RuntimeResourceClass };

export type RuntimeRouteKind = "worker_safe" | "process" | "project_bound_process" | "local_only";
export type SetupTargetKind = "local_host" | "remote_host";

export const HIDDEN_REASON_CODES = [
  "setup_required",
  "setup_running",
  "setup_failed",
  "verify_failed",
  "backend_auth_required",
  "backend_check_failed",
  "project_binding_required",
  "project_binding_missing_context",
  "project_binding_unsupported",
  "project_binding_auth_failed",
  "project_binding_metadata_unknown",
  "project_binding_sync_failed",
  "project_binding_retry_exhausted",
  "project_binding_quarantined",
  "project_binding_invalid_cwd",
  "project_binding_policy_denied",
  "project_binding_syncing",
  "project_binding_blocked",
  "project_binding_stale",
  "policy_denied",
  "docker_required",
  "docker_denied",
  "browser_required",
  "browser_denied",
  "resource_class_denied",
  "local_only",
  "invalid_bundle",
  "unsupported_backend",
] as const;

export type HiddenReasonCode = (typeof HIDDEN_REASON_CODES)[number];

export type RuntimePlanDeployment = "local" | "remote";

export type RuntimePlanOptions = {
  deployment?: RuntimePlanDeployment | undefined;
  resourcePolicy?: RuntimeResourcePolicy | undefined;
};

export type RuntimeFeatureProvenanceSource =
  | "explicit"
  | "setup.commands"
  | "setup.verify"
  | "mcp.command"
  | "cli.command"
  | "cli.action";

export type RuntimeFeatureProvenance = {
  feature: RuntimeFeature;
  source: RuntimeFeatureProvenanceSource;
  matched: string;
  command?: string | undefined;
};

export type RuntimeResourcePolicy = {
  maxClass?: RuntimeResourceClass | undefined;
};

export type RuntimeResourceResolution = {
  class: RuntimeResourceClass;
  cpu: number;
  memoryMb: number;
  diskMb: number;
  cappedByPolicy?: RuntimeResourceClass | undefined;
};

export type RuntimeRequirementsResolution = {
  features: RuntimeFeature[];
  featureProvenance: RuntimeFeatureProvenance[];
  resources: RuntimeResourceResolution;
};

export type CapletRuntimePlan = {
  id: string;
  backend: CapletConfig["backend"] | string;
  route: RuntimeRouteKind;
  setupTarget?: SetupTargetKind | undefined;
  setupRequired: boolean;
  authRequired: boolean;
  projectBindingRequired: boolean;
  runtime: RuntimeRequirementsResolution;
  caplet: CapletConfig | Record<string, unknown>;
};
