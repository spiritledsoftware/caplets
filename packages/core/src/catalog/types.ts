export type CatalogSourceProvider = "github";

export type CatalogTrustLevel = "official" | "community";

export type CatalogReadiness = "ready" | "required" | "unknown";

export type CatalogEntryKey = string;

export type CatalogSourceIdentity = {
  provider: CatalogSourceProvider;
  owner: string;
  repo: string;
  repository: string;
  canonicalUrl: string;
};

export type CatalogInstallCommand = {
  text: string;
  copyable: boolean;
  revisionBound: boolean;
  reason?:
    | "revision_unavailable"
    | "revision_install_unsupported"
    | "unsupported_source"
    | undefined;
};

export type CatalogWarningCode =
  | "unverified_community"
  | "local_control"
  | "mutating_saas"
  | "auth_required"
  | "setup_required"
  | "project_binding_required"
  | "readiness_unknown";

export type CatalogWarningSeverity = "info" | "caution" | "danger";

export type CatalogWarning = {
  code: CatalogWarningCode;
  severity: CatalogWarningSeverity;
  label: string;
  message: string;
};

export type CatalogIndexingIneligibleReason =
  | "credential_url"
  | "empty_source"
  | "local_path"
  | "private_host"
  | "unsupported_source";

export type CatalogIndexingEligibility =
  | {
      eligible: true;
      source: CatalogSourceIdentity;
    }
  | {
      eligible: false;
      reason: CatalogIndexingIneligibleReason;
      redactedSource: "[redacted]";
    };

export type CatalogIndexingStatus =
  | "accepted"
  | "already_current"
  | "counted"
  | "ineligible"
  | "rate_limited"
  | "rejected"
  | "revision_unavailable"
  | "suppressed"
  | "unavailable";

export type CatalogWorkflowSummary = {
  kind: "code_mode" | "mcp" | "openapi" | "google_discovery" | "graphql" | "http" | "cli" | "set";
  label: string;
};

export type CatalogIcon =
  | {
      type: "url";
      url: string;
    }
  | {
      type: "bundled";
      path: string;
      url: string;
    };

export type CatalogEntryInput = {
  id: string;
  name: string;
  description: string;
  source: CatalogSourceIdentity;
  sourcePath: string;
  trustLevel: CatalogTrustLevel;
  resolvedRevision?: string | undefined;
  indexedContentHash?: string | undefined;
  contentMarkdown?: string | undefined;
  icon?: CatalogIcon | undefined;
  tags?: string[] | undefined;
  useWhen?: string | undefined;
  avoidWhen?: string | undefined;
  setupRequired?: boolean | undefined;
  authRequired?: boolean | undefined;
  projectBindingRequired?: boolean | undefined;
  workflow?: CatalogWorkflowSummary | undefined;
  mutatesExternalState?: boolean | undefined;
  localControl?: boolean | undefined;
};

export type CatalogEntry = {
  entryKey: CatalogEntryKey;
  id: string;
  name: string;
  description: string;
  source: CatalogSourceIdentity;
  sourcePath: string;
  trustLevel: CatalogTrustLevel;
  resolvedRevision?: string | undefined;
  indexedContentHash?: string | undefined;
  contentMarkdown?: string | undefined;
  icon?: CatalogIcon | undefined;
  tags: string[];
  intendedTask: string | "unknown";
  avoidWhen?: string | undefined;
  setupReadiness: CatalogReadiness;
  authReadiness: CatalogReadiness;
  projectBindingReadiness: CatalogReadiness;
  workflow: CatalogWorkflowSummary | { kind: "unknown"; label: "Unknown" };
  installCommand: CatalogInstallCommand;
  warnings: CatalogWarning[];
};
