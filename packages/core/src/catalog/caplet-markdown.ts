import { parse as parseYaml } from "yaml";
import { catalogWorkflowSummaryForBackendFamily } from "./entry";
import { catalogIconReferenceFromValue, resolveCatalogIcon } from "./icon";
import type {
  CatalogIcon,
  CatalogSourceIdentity,
  CatalogTrustLevel,
  CatalogWorkflowSummary,
} from "./types";

export function readCatalogCapletFrontmatterFromMarkdown(
  markdown: string,
): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown);
  if (!match?.[1]) return {};
  const parsed = parseYaml(match[1]);
  return isRecord(parsed) ? parsed : {};
}

export function catalogStringFromFrontmatter(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function catalogStringArrayFromFrontmatter(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function catalogIconFromFrontmatter(
  frontmatter: Record<string, unknown>,
  context: {
    id: string;
    source: CatalogSourceIdentity;
    sourcePath: string;
    trustLevel: CatalogTrustLevel;
    resolvedRevision?: string | undefined;
  },
): CatalogIcon | undefined {
  const catalog = isRecord(frontmatter.catalog) ? frontmatter.catalog : undefined;
  return resolveCatalogIcon({
    ...context,
    reference: catalogIconReferenceFromValue(catalog?.icon),
  });
}

export function catalogSetupRequiredFromFrontmatter(frontmatter: Record<string, unknown>): boolean {
  return frontmatter.setup !== undefined || catalogPluralBackends(frontmatter).some(hasSetup);
}

export function catalogAuthRequiredFromFrontmatter(frontmatter: Record<string, unknown>): boolean {
  return catalogCapletAuthBlocks(frontmatter).some((auth) => auth.type !== "none");
}

export function catalogProjectBindingRequiredFromFrontmatter(
  frontmatter: Record<string, unknown>,
): boolean {
  return (
    (isRecord(frontmatter.projectBinding) && frontmatter.projectBinding.required === true) ||
    catalogPluralBackends(frontmatter).some(hasProjectBinding)
  );
}

export function catalogWorkflowSummaryFromFrontmatter(
  frontmatter: Record<string, unknown>,
  fallback: CatalogWorkflowSummary,
): CatalogWorkflowSummary {
  return catalogWorkflowSummaryForBackendFamily(catalogBackendFamilies(frontmatter)[0]) ?? fallback;
}

export function catalogMutatesExternalStateFromFrontmatter(
  frontmatter: Record<string, unknown>,
): boolean {
  if (frontmatter.graphqlEndpoint !== undefined || frontmatter.graphqlEndpoints !== undefined) {
    return true;
  }
  if (
    frontmatter.openapiEndpoint !== undefined ||
    frontmatter.googleDiscoveryApi !== undefined ||
    frontmatter.openapiEndpoints !== undefined ||
    frontmatter.googleDiscoveryApis !== undefined
  ) {
    return true;
  }
  const httpApi = frontmatter.httpApi;
  if (isRecord(httpApi) && isRecord(httpApi.actions)) {
    return Object.values(httpApi.actions).some((action) => {
      if (!isRecord(action)) return false;
      return typeof action.method === "string" && action.method.toUpperCase() !== "GET";
    });
  }
  if (isRecord(frontmatter.cliTools) && isRecord(frontmatter.cliTools.actions)) {
    return Object.values(frontmatter.cliTools.actions).some((action) => {
      if (!isRecord(action) || !isRecord(action.annotations)) return true;
      return action.annotations.readOnlyHint !== true;
    });
  }
  for (const httpApi of catalogPluralBackendValues(frontmatter.httpApis)) {
    if (isRecord(httpApi.actions)) {
      const mutates = Object.values(httpApi.actions).some((action) => {
        if (!isRecord(action)) return false;
        return typeof action.method === "string" && action.method.toUpperCase() !== "GET";
      });
      if (mutates) return true;
    }
  }
  if (isRecord(frontmatter.cliTools) && !isRecord(frontmatter.cliTools.actions)) {
    return catalogPluralBackendValues(frontmatter.cliTools).some((cliTools) => {
      if (!isRecord(cliTools.actions)) return false;
      return Object.values(cliTools.actions).some((action) => {
        if (!isRecord(action) || !isRecord(action.annotations)) return true;
        return action.annotations.readOnlyHint !== true;
      });
    });
  }
  return false;
}

export function catalogUsesLocalControlFromFrontmatter(
  frontmatter: Record<string, unknown>,
): boolean {
  const runtime = isRecord(frontmatter.runtime) ? frontmatter.runtime : undefined;
  const runtimeFeatures = Array.isArray(runtime?.features) ? runtime.features : [];
  return (
    catalogProjectBindingRequiredFromFrontmatter(frontmatter) ||
    runtimeFeatures.length > 0 ||
    frontmatter.cliTools !== undefined ||
    isLocalMcpServer(frontmatter) ||
    catalogPluralBackends(frontmatter).some(hasRuntimeFeatures) ||
    catalogPluralBackendValues(frontmatter.mcpServers).some(
      (server) => typeof server.command === "string",
    )
  );
}

function catalogBackendFamilies(frontmatter: Record<string, unknown>): string[] {
  const families: Array<readonly [string, string]> = [
    ["mcp", "mcpServer"],
    ["mcp", "mcpServers"],
    ["openapi", "openapiEndpoint"],
    ["openapi", "openapiEndpoints"],
    ["googleDiscovery", "googleDiscoveryApi"],
    ["googleDiscovery", "googleDiscoveryApis"],
    ["graphql", "graphqlEndpoint"],
    ["graphql", "graphqlEndpoints"],
    ["http", "httpApi"],
    ["http", "httpApis"],
    ["cli", "cliTools"],
    ["caplets", "capletSet"],
    ["caplets", "capletSets"],
  ];
  return families.flatMap(([family, key]) => (frontmatter[key] === undefined ? [] : [family]));
}

function catalogCapletAuthBlocks(
  frontmatter: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const key of [
    "mcpServer",
    "openapiEndpoint",
    "googleDiscoveryApi",
    "graphqlEndpoint",
    "httpApi",
  ]) {
    const backend = frontmatter[key];
    if (isRecord(backend) && isRecord(backend.auth)) blocks.push(backend.auth);
  }
  if (isRecord(frontmatter.auth)) blocks.push(frontmatter.auth);
  for (const key of [
    "mcpServers",
    "openapiEndpoints",
    "googleDiscoveryApis",
    "graphqlEndpoints",
    "httpApis",
  ]) {
    for (const backend of catalogPluralBackendValues(frontmatter[key])) {
      if (isRecord(backend.auth)) blocks.push(backend.auth);
    }
  }
  return blocks;
}

function isLocalMcpServer(frontmatter: Record<string, unknown>): boolean {
  const mcpServer = frontmatter.mcpServer;
  return isRecord(mcpServer) && typeof mcpServer.command === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function catalogPluralBackendValues(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  return Object.values(value).filter(isRecord);
}

function catalogPluralBackends(frontmatter: Record<string, unknown>): Record<string, unknown>[] {
  return [
    ...catalogPluralBackendValues(frontmatter.mcpServers),
    ...catalogPluralBackendValues(frontmatter.openapiEndpoints),
    ...catalogPluralBackendValues(frontmatter.googleDiscoveryApis),
    ...catalogPluralBackendValues(frontmatter.graphqlEndpoints),
    ...catalogPluralBackendValues(frontmatter.httpApis),
    ...(isRecord(frontmatter.cliTools) && !isRecord(frontmatter.cliTools.actions)
      ? catalogPluralBackendValues(frontmatter.cliTools)
      : []),
    ...catalogPluralBackendValues(frontmatter.capletSets),
  ];
}

function hasSetup(value: Record<string, unknown>): boolean {
  return value.setup !== undefined;
}

function hasProjectBinding(value: Record<string, unknown>): boolean {
  return isRecord(value.projectBinding) && value.projectBinding.required === true;
}

function hasRuntimeFeatures(value: Record<string, unknown>): boolean {
  const runtime = isRecord(value.runtime) ? value.runtime : undefined;
  return Array.isArray(runtime?.features) && runtime.features.length > 0;
}
