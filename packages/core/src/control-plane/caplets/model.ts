import type { CanonicalModelVersion, ContentHash } from "../model";

export const PORTABLE_CAPLET_VERSION = 1 as const;
export const PORTABLE_BACKEND_KINDS = [
  "mcp",
  "openapi",
  "googleDiscovery",
  "graphql",
  "http",
  "cli",
  "caplets",
  "mixed",
] as const;

export type PortableBackendKind = (typeof PORTABLE_BACKEND_KINDS)[number];
export type PortableJson =
  | null
  | boolean
  | number
  | string
  | PortableJson[]
  | { [key: string]: PortableJson };

export type PortableLocalReference = { type: "local"; owner: string; path: string };
export type PortableExternalReference = { type: "external"; owner: string; url: string };
export type PortableSetupReference = { type: "unresolved-setup"; owner: string; name: string };
export type PortableReference =
  | PortableLocalReference
  | PortableExternalReference
  | PortableSetupReference;

export type PortableDeclaredInput = {
  name: string;
  reference:
    | Omit<PortableLocalReference, "owner">
    | Omit<PortableExternalReference, "owner">
    | Omit<PortableSetupReference, "owner">;
};

export type PortableCatalogMetadata = {
  displayName?: string;
  summary?: string;
  tags?: string[];
  icon?: { type: "local"; path: string } | { type: "external"; url: string };
};

export type PortableAssetRole =
  | "asset"
  | "icon"
  | "document"
  | "openapi"
  | "graphql-schema"
  | "graphql-operation"
  | "config";

export type PortableCapletAsset = {
  path: string;
  role: PortableAssetRole;
  mediaType: string;
  encoding: "base64";
  content: string;
  contentHash: ContentHash;
  byteLength: number;
};

export type PortableCaplet = {
  portableVersion: typeof PORTABLE_CAPLET_VERSION;
  canonicalModelVersion: CanonicalModelVersion;
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  frontmatter: {
    source: PortableJson;
    backend: { kind: PortableBackendKind; config: PortableJson };
    catalog?: PortableCatalogMetadata;
    declaredInputs: PortableDeclaredInput[];
  };
  body: string;
  assets: PortableCapletAsset[];
  references: PortableReference[];
};

export const PORTABLE_CAPLET_TOP_LEVEL_FIELDS = [
  "portableVersion",
  "canonicalModelVersion",
  "id",
  "name",
  "description",
  "sourcePath",
  "frontmatter",
  "body",
  "assets",
  "references",
] as const;

export type CapletOwnershipState = "sql" | "filesystem";
export type CapletActivationState = "active" | "setup-required" | "dormant-shadowed" | "disabled";

export type CanonicalCapletAggregate = {
  modelVersion: CanonicalModelVersion;
  id: string;
  aggregateVersion: number;
  ownership: CapletOwnershipState;
  activation: CapletActivationState;
  effective: boolean;
  portable: PortableCaplet;
  installationProvenanceId?: string;
  updateState: "current" | "update-available" | "updating" | "failed";
};

export type CapletPlacementDecision =
  | { state: "active"; effective: true }
  | { state: "setup-required"; effective: false }
  | { state: "default-sql-id-collision"; effective: false }
  | { state: "sql-replacement-approved"; effective: boolean }
  | { state: "filesystem-ownership-rejected"; effective: false }
  | { state: "dormant-shadowed"; effective: false };

export function classifyCapletPlacement(input: {
  existingSql: boolean;
  filesystemOwned: boolean;
  replacingSql: boolean;
  setupComplete: boolean;
  inspectingExisting?: boolean;
}): CapletPlacementDecision {
  if (input.filesystemOwned) {
    return input.inspectingExisting && input.existingSql
      ? { state: "dormant-shadowed", effective: false }
      : { state: "filesystem-ownership-rejected", effective: false };
  }
  if (input.existingSql && !input.replacingSql) {
    return { state: "default-sql-id-collision", effective: false };
  }
  if (input.existingSql) {
    return { state: "sql-replacement-approved", effective: input.setupComplete };
  }
  return input.setupComplete
    ? { state: "active", effective: true }
    : { state: "setup-required", effective: false };
}

export const CAPLET_RELATIONAL_CHECKLIST = [
  "caplet identity and aggregate version",
  "typed backend row and ordered repeating backend children",
  "dedicated Markdown body column",
  "catalog metadata and typed icon relation or external URL",
  "declared non-secret inputs and typed references",
  "binary/text assets with owner, role, media type, bytes, and hash",
  "source and content-hash provenance",
  "SQL ownership distinct from filesystem ownership",
  "effective state distinct from dormant or setup-required state",
  "update state and activation history",
] as const;
