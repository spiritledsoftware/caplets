import type { CapletConfig, RuntimeFeature, RuntimeResourceClass } from "../config-runtime";

export type HostedRuntimeResourceClass = RuntimeResourceClass | "small" | "medium";

export type { RuntimeFeature, RuntimeResourceClass };

export type RuntimeRouteKind = "worker_safe" | "process" | "project_bound_process" | "local_only";
export type SetupTargetKind = "local_host" | "remote_host" | "hosted_sandbox";
export type HostedSetupState =
  | "not_required"
  | "approval_required"
  | "approved"
  | "queued"
  | "running"
  | "verifying"
  | "ready"
  | "failed"
  | "expired";

export type HostedBackendCheckState =
  | "not_run"
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "stale";

export type HostedSandboxState =
  | "not_started"
  | "preparing"
  | "uploading_bundle"
  | "running_setup"
  | "starting_adapter"
  | "ready"
  | "busy"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

export const HIDDEN_REASON_CODES = [
  "setup_required",
  "setup_running",
  "setup_failed",
  "verify_failed",
  "backend_auth_required",
  "backend_check_failed",
  "project_binding_required",
  "project_binding_syncing",
  "project_binding_blocked",
  "project_binding_stale",
  "provider_unavailable",
  "provider_capacity_exhausted",
  "provider_queue_timeout",
  "policy_denied",
  "billing_required",
  "subscription_past_due",
  "usage_limit_reached",
  "email_verification_required",
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

export type RuntimePlanDeployment = "hosted" | "self_hosted" | "local";

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
  maxClass?: HostedRuntimeResourceClass | undefined;
};

export type RuntimeResourceResolution = {
  class: HostedRuntimeResourceClass;
  cpu: number;
  memoryMb: number;
  diskMb: number;
  cappedByPolicy?: HostedRuntimeResourceClass | undefined;
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

export type HostedRoutePlan = {
  workspaceId: string;
  capletId: string;
  contentHash: string;
  bundleRevision: string;
  route: RuntimeRouteKind;
  backend: string;
  runtimeFeatures: string[];
  resourceClass: HostedRuntimeResourceClass;
  setupState: HostedSetupState;
  checkState: HostedBackendCheckState;
  projectBindingRequired: boolean;
  projectFingerprint?: string | undefined;
  hiddenReasons: HiddenReasonCode[];
  primaryHiddenReason?: HiddenReasonCode | undefined;
  policyDecision: "allowed" | "denied" | "not_evaluated";
  provenanceSource: "bundle_validation" | "install" | "runtime_refresh" | "call";
  updatedAt: string;
};

export type HostedCallProvenance = {
  requestId: string;
  workspaceId: string;
  capletId: string;
  contentHash: string;
  route: RuntimeRouteKind;
  backend: string;
  provider?: "daytona" | undefined;
  sandboxId?: string | undefined;
  snapshotId?: string | undefined;
  runtimeFeatures: string[];
  projectFingerprint?: string | undefined;
  usageEventIds: string[];
  auditEventId?: string | undefined;
};
