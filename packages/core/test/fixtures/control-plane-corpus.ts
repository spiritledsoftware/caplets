import type { ControlPlaneEntityKind } from "../../src/control-plane/model";
import type { PortableBackendKind } from "../../src/control-plane/caplets/model";
import type { LegacyDomain } from "../../src/control-plane/migration/legacy-model";

export const CANONICAL_ENTITY_KINDS_FIXTURE = [
  "host-setting",
  "caplet",
  "caplet-provenance",
  "operation-namespace",
  "operation-reservation",
  "operation-outcome",
  "operation-tombstone",
  "confirmation",
  "oauth-token",
  "client",
  "credential",
  "pending-approval",
  "dashboard-session",
  "project-binding-workspace",
  "project-binding-lease",
  "project-binding-receipt",
  "vault-value",
  "vault-grant",
  "operator-activity",
  "authority-version",
  "effective-version",
  "security-version",
  "key-inventory",
  "key-canary",
  "cluster-node-lease",
  "writer-fence",
  "migration",
  "backup",
  "recovery",
  "retention",
  "external-destruction",
  "recovery-checkpoint",
  "quarantine",
] as const satisfies readonly ControlPlaneEntityKind[];

export const PORTABLE_BACKEND_KINDS_FIXTURE = [
  "mcp",
  "openapi",
  "googleDiscovery",
  "graphql",
  "http",
  "cli",
  "caplets",
] as const satisfies readonly PortableBackendKind[];

export const LEGACY_DOMAINS_FIXTURE = [
  "oauth-token",
  "remote-server-state",
  "dashboard-session",
  "remote-profile",
  "remote-profile-credential",
  "cloud-auth",
  "vault-value",
  "vault-grant",
  "project-binding-workspace",
  "project-binding-lease",
  "project-binding-receipt",
  "operator-activity",
  "host-setting",
  "host-authority",
  "global-provenance",
] as const satisfies readonly LegacyDomain[];

export const OPERATION_TRANSITION_FIXTURE = [
  ["unseen", "reserved"],
  ["unseen", "not_committed"],
  ["reserved", "committed"],
  ["reserved", "superseded"],
] as const;
