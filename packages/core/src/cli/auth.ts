import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  deleteTokenBundle,
  isTokenBundleExpired,
  readTokenBundle,
  refreshOAuthTokenBundle,
  runGenericOAuthFlow,
  runOAuthFlow,
  type GenericAuthTarget,
  type OAuthTokenStore,
} from "../auth";
import type { CurrentHostCatalogOperations } from "../current-host/catalog-operations";
import type {
  CurrentHostOperations,
  CurrentHostOperatorPrincipal,
} from "../current-host/operations";
import type { LocalSetupStore } from "../setup/local-store";
import type { VaultCliStore } from "./vault";

import {
  loadConfig,
  loadGlobalConfig,
  loadProjectConfig,
  vaultBootstrapResolver,
  vaultResolverForAuthDir,
  type CapletsConfig,
  type GoogleDiscoveryApiConfig,
  type GraphQlEndpointConfig,
  type HttpApiConfig,
} from "../config";
import { CapletsError, toSafeError } from "../errors";
import { GoogleDiscoveryManager } from "../google-discovery";
import { ServerRegistry } from "../registry";

/**
 * Resources resolved once at the CLI boundary for a shared Current Host.
 *
 * The resolver owns the authority/coordinator lifecycle; command handlers only
 * consume the injected stores/facade and never construct a synchronous engine.
 * Client-local commands intentionally do not receive this context.
 */
export type CliAuthorityContext = {
  config?: CapletsConfig | undefined;
  tokenStore?: OAuthTokenStore | undefined;
  vaultStore?: VaultCliStore | undefined;
  setupStore?: LocalSetupStore | undefined;
  catalog?: CurrentHostCatalogOperations | undefined;
  currentHost?: CurrentHostOperations | undefined;
  principal?: CurrentHostOperatorPrincipal | undefined;
  close?: (() => Promise<void>) | undefined;
};

type AuthTarget = ReturnType<typeof authTargets>[number];
type AuthListFormat = "plain" | "markdown" | "json";
export type AuthSource = "project" | "global" | "remote";

export type AuthStatusRow = {
  server: string;
  status: "missing" | "expired" | "authenticated";
  expiresAt?: string;
  scope?: string;
  source?: AuthSource;
};

export async function loginAuth(
  serverId: string,
  options: {
    configPath?: string;
    noOpen: boolean;
    writeOut: (value: string) => void;
    writeErr: (value: string) => void;
    authDir?: string;
    tokenStore?: OAuthTokenStore | undefined;
    authority?: CliAuthorityContext | undefined;
    config?: CapletsConfig;
  },
): Promise<void> {
  const config = options.config ?? options.authority?.config ?? loadAuthConfigForCli(options);
  const tokenStore = options.tokenStore ?? options.authority?.tokenStore;
  const server = await resolveAuthTarget(serverId, config, options.authDir, tokenStore);
  assertLoginTarget(server, serverId);

  try {
    const flowOptions = {
      noOpen: options.noOpen,
      ...(options.authDir ? { authDir: options.authDir } : {}),
      ...(tokenStore ? { tokenStore } : {}),
      ...(options.noOpen ? { readManualInput: maybeReadManualInput } : {}),
      print: (line: string) => options.writeOut(`${line}\n`),
    };
    if (server.backend === "mcp") {
      await runOAuthFlow(server, flowOptions);
    } else {
      await runGenericOAuthFlow(server, flowOptions);
    }
    options.writeOut(`Authenticated \`${serverId}\`.\n`);
  } catch (error) {
    options.writeErr(`${JSON.stringify(toSafeError(error, "AUTH_FAILED"), null, 2)}\n`);
    process.exitCode = 1;
  }
}

export function logoutAuth(
  serverId: string,
  options: {
    authDir?: string;
    configPath?: string;
    config?: CapletsConfig;
    authority?: CliAuthorityContext | undefined;
    writeOut: (value: string) => void;
  },
): void {
  if (options.authority?.tokenStore) {
    throw new CapletsError(
      "ASYNC_AUTHORITY_REQUIRED",
      "Shared authority OAuth logout must use the async CLI handler.",
    );
  }
  const result = logoutAuthResult(serverId, options);
  if (result.deleted) {
    options.writeOut(`Deleted OAuth credentials for \`${serverId}\`.\n`);
  } else {
    options.writeOut(`No OAuth credentials found for \`${serverId}\`.\n`);
  }
}

export function logoutAuthResult(
  serverId: string,
  options: {
    authDir?: string;
    configPath?: string;
    config?: CapletsConfig;
    authority?: CliAuthorityContext | undefined;
  },
): { server: string; deleted: boolean } {
  if (options.authority?.tokenStore) {
    throw new CapletsError(
      "ASYNC_AUTHORITY_REQUIRED",
      "Shared authority OAuth logout must use the async CLI handler.",
    );
  }
  const target = findAuthTarget(
    serverId,
    options.config ?? options.authority?.config ?? loadAuthConfigForCli(options),
  );
  assertLoginTarget(target, serverId);
  return { server: serverId, deleted: deleteTokenBundle(serverId, options.authDir) };
}

export async function logoutAuthAsync(
  serverId: string,
  options: {
    authDir?: string;
    tokenStore?: OAuthTokenStore | undefined;
    authority?: CliAuthorityContext | undefined;
    configPath?: string;
    config?: CapletsConfig;
    writeOut: (value: string) => void;
  },
): Promise<void> {
  const target = findAuthTarget(
    serverId,
    options.config ?? options.authority?.config ?? loadAuthConfigForCli(options),
  );
  assertLoginTarget(target, serverId);
  const tokenStore = options.tokenStore ?? options.authority?.tokenStore;
  const deleted = tokenStore
    ? await tokenStore.delete(serverId)
    : deleteTokenBundle(serverId, options.authDir);
  options.writeOut(
    deleted
      ? `Deleted OAuth credentials for \`${serverId}\`.\n`
      : `No OAuth credentials found for \`${serverId}\`.\n`,
  );
}

export async function refreshAuth(
  serverId: string,
  options: {
    authDir?: string;
    tokenStore?: OAuthTokenStore | undefined;
    authority?: CliAuthorityContext | undefined;
    configPath?: string;
    config?: CapletsConfig;
    writeOut: (value: string) => void;
  },
): Promise<void> {
  await refreshAuthResult(serverId, options);
  options.writeOut(`Refreshed OAuth credentials for \`${serverId}\`.\n`);
}

export async function refreshAuthResult(
  serverId: string,
  options: {
    authDir?: string;
    tokenStore?: OAuthTokenStore | undefined;
    authority?: CliAuthorityContext | undefined;
    configPath?: string;
    config?: CapletsConfig;
  },
): Promise<{ server: string }> {
  const tokenStore = options.tokenStore ?? options.authority?.tokenStore;
  const target = await resolveAuthTarget(
    serverId,
    options.config ?? options.authority?.config ?? loadAuthConfigForCli(options),
    options.authDir,
    tokenStore,
  );
  assertLoginTarget(target, serverId);
  await refreshOAuthTokenBundle(target, options.authDir, tokenStore ? { tokenStore } : {});
  return { server: serverId };
}

export function listAuth(options: {
  authDir?: string;
  configPath?: string;
  writeOut: (value: string) => void;
  format?: AuthListFormat;
}): void {
  const rows = listAuthRows(options);
  const format = options.format ?? "plain";
  if (format === "json") {
    options.writeOut(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  options.writeOut(formatAuthRows(rows, format));
}

export async function listAuthAsync(options: {
  authDir?: string;
  tokenStore?: OAuthTokenStore | undefined;
  authority?: CliAuthorityContext | undefined;
  configPath?: string;
  config?: CapletsConfig | undefined;
  writeOut: (value: string) => void;
  format?: AuthListFormat;
}): Promise<void> {
  const rows = await listAuthRowsAsync(options);
  const format = options.format ?? "plain";
  if (format === "json") {
    options.writeOut(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  options.writeOut(formatAuthRows(rows, format));
}

export async function listAuthRowsAsync(options: {
  authDir?: string;
  tokenStore?: OAuthTokenStore | undefined;
  authority?: CliAuthorityContext | undefined;
  configPath?: string;
  config?: CapletsConfig | undefined;
}): Promise<AuthStatusRow[]> {
  const config = options.config ?? options.authority?.config ?? loadAuthConfigForCli(options);
  const tokenStore = options.tokenStore ?? options.authority?.tokenStore;
  return authRowsForTargetsAsync(authTargets(config), options.authDir, tokenStore);
}

export function listAuthRows(options: { authDir?: string; configPath?: string }): AuthStatusRow[] {
  const config = loadConfig(options.configPath, undefined, {
    vaultResolver: vaultBootstrapResolver,
  });
  return authRowsForTargets(authTargets(config), options.authDir);
}

function loadAuthConfigForCli(options: {
  authDir?: string | undefined;
  configPath?: string | undefined;
  config?: CapletsConfig | undefined;
  authority?: CliAuthorityContext | undefined;
}): CapletsConfig {
  if (options.config) return options.config;
  if (options.authority) {
    throw new CapletsError(
      "ASYNC_AUTHORITY_REQUIRED",
      "Shared authority CLI commands require an async prepared host config.",
    );
  }
  return loadConfig(options.configPath, undefined, {
    vaultResolver: vaultResolverForAuthDir(options.authDir),
  });
}

export function listLocalAuthRows(options: {
  authDir?: string;
  configPath?: string;
  projectConfigPath?: string;
  source?: Exclude<AuthSource, "remote">;
}): AuthStatusRow[] {
  return authRowsForTargets(localAuthTargets(options), options.authDir);
}

export async function listLocalAuthRowsAsync(options: {
  authDir?: string;
  tokenStore?: OAuthTokenStore | undefined;
  authority?: CliAuthorityContext | undefined;
  configPath?: string;
  projectConfigPath?: string;
  source?: Exclude<AuthSource, "remote">;
}): Promise<AuthStatusRow[]> {
  const tokenStore = options.tokenStore ?? options.authority?.tokenStore;
  return authRowsForTargetsAsync(localAuthTargets(options), options.authDir, tokenStore);
}

export function localAuthTargets(options: {
  configPath?: string;
  projectConfigPath?: string;
  source?: Exclude<AuthSource, "remote">;
}): (AuthTarget & { source: Exclude<AuthSource, "remote"> })[] {
  return [
    ...(options.source === "project" ? [] : authTargetsForSource("global", options)),
    ...(options.source === "global" ? [] : authTargetsForSource("project", options)),
  ].filter((target) => !options.source || target.source === options.source);
}

export function localAuthConfigForTarget(options: {
  serverId: string;
  authDir?: string | undefined;
  configPath?: string;
  projectConfigPath?: string;
  source: Exclude<AuthSource, "remote">;
}): CapletsConfig {
  const target = localAuthTargets(options).find(
    (candidate) => candidate.server === options.serverId,
  );
  assertLoginTarget(target, options.serverId);
  return loadConfigForSource(options.source, options, {
    vaultResolver: vaultResolverForAuthDir(options.authDir),
  });
}

function authTargetsForSource(
  source: Exclude<AuthSource, "remote">,
  options: { configPath?: string; projectConfigPath?: string },
): (AuthTarget & { source: Exclude<AuthSource, "remote"> })[] {
  try {
    return authTargets(loadConfigForSource(source, options)).map((target) => ({
      ...target,
      source,
    }));
  } catch (error) {
    if (error instanceof CapletsError && error.code === "CONFIG_NOT_FOUND") {
      return [];
    }
    throw error;
  }
}

function loadConfigForSource(
  source: Exclude<AuthSource, "remote">,
  options: { configPath?: string; projectConfigPath?: string },
  loadOptions: Parameters<typeof loadGlobalConfig>[1] = { vaultResolver: vaultBootstrapResolver },
): CapletsConfig {
  if (source === "global") {
    return loadGlobalConfig(options.configPath, loadOptions);
  }
  return loadProjectConfig(options.projectConfigPath, loadOptions);
}

function authRowsForTargets(
  targets: (AuthTarget & { source?: AuthSource })[],
  authDir?: string,
): AuthStatusRow[] {
  return targets
    .sort((left, right) => left.server.localeCompare(right.server))
    .map((server) => {
      const bundle = readTokenBundle(server.server, authDir);
      const status = !bundle
        ? "missing"
        : isTokenBundleExpired(bundle)
          ? "expired"
          : "authenticated";
      return {
        server: server.server,
        status,
        ...(bundle?.expiresAt ? { expiresAt: bundle.expiresAt } : {}),
        ...(bundle?.scope ? { scope: bundle.scope } : {}),
        ...(server.source ? { source: server.source } : {}),
      };
    });
}

async function authRowsForTargetsAsync(
  targets: (AuthTarget & { source?: AuthSource })[],
  authDir: string | undefined,
  tokenStore: OAuthTokenStore | undefined,
): Promise<AuthStatusRow[]> {
  const bundles = tokenStore
    ? await tokenStore.list()
    : targets
        .map((target) => readTokenBundle(target.server, authDir))
        .filter((bundle): bundle is NonNullable<typeof bundle> => Boolean(bundle));
  const byServer = new Map(bundles.map((bundle) => [bundle.server, bundle]));
  return targets
    .sort((left, right) => left.server.localeCompare(right.server))
    .map((server) => {
      const bundle = byServer.get(server.server);
      const status = !bundle
        ? "missing"
        : isTokenBundleExpired(bundle)
          ? "expired"
          : "authenticated";
      return {
        server: server.server,
        status,
        ...(bundle?.expiresAt ? { expiresAt: bundle.expiresAt } : {}),
        ...(bundle?.scope ? { scope: bundle.scope } : {}),
        ...(server.source ? { source: server.source } : {}),
      };
    });
}

export function formatAuthRows(
  rows: AuthStatusRow[],
  format: Exclude<AuthListFormat, "json">,
): string {
  if (rows.length === 0) {
    return format === "markdown"
      ? "## OAuth credentials\n\nNo configured OAuth servers found.\n"
      : "No configured OAuth servers found.\n";
  }
  let output = "";
  if (format === "markdown") {
    output += "## OAuth credentials\n\n";
  } else {
    output += "OAuth credentials\n\n";
  }
  for (const row of rows) {
    const details = [
      row.source ? `source ${row.source}` : undefined,
      row.expiresAt ? `expires ${row.expiresAt}` : undefined,
      row.scope ? `scope ${row.scope}` : undefined,
    ]
      .filter(Boolean)
      .join("; ");
    if (format === "markdown") {
      output += `- \`${row.server}\` — ${row.status}${details ? ` (${details})` : ""}\n`;
      continue;
    }
    output +=
      [
        row.server,
        `  Status: ${row.status}`,
        ...(row.source ? [`  Source: ${row.source}`] : []),
        ...(row.expiresAt ? [`  Expires: ${row.expiresAt}`] : []),
        ...(row.scope ? [`  Scope: ${row.scope}`] : []),
      ].join("\n") + "\n\n";
  }
  return output;
}

export function findAuthTarget(serverId: string, config = loadConfig()): AuthTarget | undefined {
  return authTargets(config).find((server) => server.server === serverId);
}

export async function resolveAuthTarget(
  serverId: string,
  config: CapletsConfig,
  authDir?: string,
  tokenStore?: OAuthTokenStore,
): Promise<AuthTarget | undefined> {
  const target = findAuthTarget(serverId, config);
  if (target?.backend !== "googleDiscovery") return target;
  const api = config.googleDiscoveryApis[serverId];
  if (!api || (api.auth.type !== "oauth2" && api.auth.type !== "oidc")) return target;
  const manager = new GoogleDiscoveryManager(
    new ServerRegistry(config),
    tokenStore ? { ...(authDir ? { authDir } : {}), tokenStore } : authDir ? { authDir } : {},
  );
  const baseUrl =
    api.baseUrl ?? (await manager.resolveBaseUrl(api).catch(() => undefined)) ?? api.discoveryUrl;
  return {
    ...target,
    ...(baseUrl ? { baseUrl } : {}),
    ...(api.auth.scopes?.length ? {} : { resolvedScopes: await manager.resolveAuthScopes(api) }),
  };
}

function authTargets(config: ReturnType<typeof loadConfig>) {
  return [
    ...Object.values(config.mcpServers).filter(
      (server) =>
        server.transport !== "stdio" &&
        (server.auth?.type === "oauth2" || server.auth?.type === "oidc"),
    ),
    ...Object.values(config.openapiEndpoints).filter(
      (endpoint) => endpoint.auth?.type === "oauth2" || endpoint.auth?.type === "oidc",
    ),
    ...Object.values(config.googleDiscoveryApis)
      .filter((api) => api.auth?.type === "oauth2" || api.auth?.type === "oidc")
      .map(googleDiscoveryAuthTarget),
    ...Object.values(config.graphqlEndpoints)
      .filter((endpoint) => endpoint.auth?.type === "oauth2" || endpoint.auth?.type === "oidc")
      .map(graphQlAuthTarget),
    ...Object.values(config.httpApis)
      .filter((api) => api.auth?.type === "oauth2" || api.auth?.type === "oidc")
      .map(httpAuthTarget),
  ];
}

function googleDiscoveryAuthTarget(
  api: GoogleDiscoveryApiConfig,
): GoogleDiscoveryApiConfig & GenericAuthTarget {
  const baseUrl = api.baseUrl ?? api.discoveryUrl;
  return {
    ...api,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function graphQlAuthTarget(
  endpoint: GraphQlEndpointConfig,
): GraphQlEndpointConfig & GenericAuthTarget {
  return {
    ...endpoint,
    url: endpoint.endpointUrl,
  };
}

function httpAuthTarget(api: HttpApiConfig): HttpApiConfig & GenericAuthTarget {
  return { ...api };
}

export function assertLoginTarget(
  target: AuthTarget | undefined,
  serverId: string,
): asserts target is AuthTarget {
  if (!target) {
    throw new CapletsError("SERVER_NOT_FOUND", `Server ${serverId} is not configured for OAuth`);
  }
  if ("disabled" in target && target.disabled) {
    throw new CapletsError("SERVER_UNAVAILABLE", `Server ${serverId} is disabled`);
  }
}

async function maybeReadManualInput(): Promise<string | undefined> {
  if (!input.isTTY) {
    return undefined;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      "Paste callback URL or authorization code after completing authorization, or press Enter to wait for loopback callback: ",
    );
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}
