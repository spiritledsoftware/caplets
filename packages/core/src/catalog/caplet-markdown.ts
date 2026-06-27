import { parse as parseYaml } from "yaml";
import { catalogWorkflowSummaryForBackendFamily } from "./entry";
import type { CatalogWorkflowSummary } from "./types";

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

export function catalogSetupRequiredFromFrontmatter(frontmatter: Record<string, unknown>): boolean {
  return frontmatter.setup !== undefined;
}

export function catalogAuthRequiredFromFrontmatter(frontmatter: Record<string, unknown>): boolean {
  const auth = catalogCapletAuth(frontmatter);
  return auth !== undefined && auth.type !== "none";
}

export function catalogProjectBindingRequiredFromFrontmatter(
  frontmatter: Record<string, unknown>,
): boolean {
  return isRecord(frontmatter.projectBinding) && frontmatter.projectBinding.required === true;
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
  if (frontmatter.graphqlEndpoint !== undefined) return true;
  if (frontmatter.openapiEndpoint !== undefined || frontmatter.googleDiscoveryApi !== undefined) {
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
    isLocalMcpServer(frontmatter)
  );
}

function catalogBackendFamilies(frontmatter: Record<string, unknown>): string[] {
  const families: Array<readonly [string, string]> = [
    ["mcp", "mcpServer"],
    ["openapi", "openapiEndpoint"],
    ["googleDiscovery", "googleDiscoveryApi"],
    ["graphql", "graphqlEndpoint"],
    ["http", "httpApi"],
    ["cli", "cliTools"],
    ["caplets", "capletSet"],
  ];
  return families.flatMap(([family, key]) => (frontmatter[key] === undefined ? [] : [family]));
}

function catalogCapletAuth(
  frontmatter: Record<string, unknown>,
): Record<string, unknown> | undefined {
  for (const key of [
    "mcpServer",
    "openapiEndpoint",
    "googleDiscoveryApi",
    "graphqlEndpoint",
    "httpApi",
  ]) {
    const backend = frontmatter[key];
    if (isRecord(backend) && isRecord(backend.auth)) return backend.auth;
  }
  return undefined;
}

function isLocalMcpServer(frontmatter: Record<string, unknown>): boolean {
  const mcpServer = frontmatter.mcpServer;
  return isRecord(mcpServer) && typeof mcpServer.command === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
