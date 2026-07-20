import { createServer } from "node:http";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import {
  auth,
  type AuthResult,
  type OAuthDiscoveryState,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth";
import {
  isTokenBundleExpired,
  type StoredOAuthTokenBundle,
  type StoredOAuthTokenBundleView,
} from "./auth/store";
import type { BackendAuthMutationOptions, BackendAuthStateStore } from "./storage/backend-auth";
import type { CapletServerConfig } from "./config";
import { CapletsError, redactSecrets } from "./errors";

export {
  authStorePath,
  deleteTokenBundle,
  isTokenBundleExpired,
  listTokenBundles,
  readTokenBundle,
  writeTokenBundle,
  type StoredOAuthTokenBundle,
} from "./auth/store";

type OAuthLikeAuthConfig = {
  type: "oauth2" | "oidc";
  authorizationUrl?: string | undefined;
  tokenUrl?: string | undefined;
  issuer?: string | undefined;
  resourceMetadataUrl?: string | undefined;
  authorizationServerMetadataUrl?: string | undefined;
  openidConfigurationUrl?: string | undefined;
  clientMetadataUrl?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  scopes?: string[] | undefined;
  redirectUri?: string | undefined;
};

export type GenericAuthTarget = {
  server: string;
  backend: "openapi" | "googleDiscovery" | "graphql" | "http";
  url?: string | undefined;
  baseUrl?: string | undefined;
  specUrl?: string | undefined;
  resolvedScopes?: string[] | undefined;
  auth?: OAuthLikeAuthConfig | { type: string } | undefined;
  requestTimeoutMs?: number | undefined;
};
type BackendAuthStoreInput = BackendAuthStateStore | string | undefined;

export function staticRemoteHeaders(server: CapletServerConfig): Record<string, string> {
  if (server.auth?.type === "bearer") {
    return { authorization: `Bearer ${server.auth.token}` };
  }
  if (server.auth?.type === "headers") {
    return server.auth.headers;
  }
  return {};
}

export async function oauthHeaders(
  server: CapletServerConfig,
  authStoreInput: BackendAuthStoreInput,
): Promise<Record<string, string>> {
  if (server.auth?.type !== "oauth2" && server.auth?.type !== "oidc") {
    return {};
  }
  const authStore = requireBackendAuthStore(authStoreInput);
  const state = await authStore.readTokenBundle(server.server);
  if (!state || (!state.bundle.accessToken && !state.bundle.refreshToken)) {
    throw new CapletsError("AUTH_REQUIRED", `OAuth credentials required for ${server.server}`, {
      server: server.server,
      authType: server.auth.type,
      nextAction: "run_caplets_auth_login",
    });
  }
  let bundle = state.bundle;
  if (!bundle.accessToken || isTokenBundleExpired(bundle)) {
    if (!server.url) {
      throw new CapletsError("CONFIG_INVALID", `${server.server} is missing url`);
    }
    bundle = await refreshGenericOAuthBundle(
      {
        server: server.server,
        backend: "http",
        url: server.url,
        auth: server.auth,
      },
      server.auth,
      {
        ...bundle,
        server: server.server,
        authType: bundle.authType ?? server.auth.type,
        clientId: bundle.clientId ?? server.auth.clientId ?? server.auth.clientMetadataUrl,
        clientSecret: bundle.clientSecret ?? server.auth.clientSecret,
        protectedResourceOrigin:
          bundle.protectedResourceOrigin ?? (server.url ? new URL(server.url).origin : undefined),
      },
      authStore,
      state.generation,
    );
  }
  if (!bundle.accessToken || isTokenBundleExpired(bundle)) {
    throw new CapletsError("AUTH_REFRESH_FAILED", `OAuth token for ${server.server} is expired`, {
      server: server.server,
      authType: server.auth.type,
      nextAction: "run_caplets_auth_login",
    });
  }
  return { authorization: `${bundle.tokenType ?? "Bearer"} ${bundle.accessToken}` };
}

export async function genericOAuthHeaders(
  target: GenericAuthTarget,
  authStoreInput?: BackendAuthStateStore | string,
): Promise<Record<string, string>> {
  if (target.auth?.type !== "oauth2" && target.auth?.type !== "oidc") {
    return {};
  }
  const authStore = requireBackendAuthStore(authStoreInput);
  const authConfig = target.auth as OAuthLikeAuthConfig;
  const state = await authStore.readTokenBundle(target.server);
  if (!state || (!state.bundle.accessToken && !state.bundle.refreshToken)) {
    throw new CapletsError("AUTH_REQUIRED", `OAuth credentials required for ${target.server}`, {
      server: target.server,
      backend: target.backend,
      authType: authConfig.type,
      nextAction: "run_caplets_auth_login",
    });
  }
  let bundle = state.bundle;
  assertTokenBundleMatchesTarget(bundle, target, authConfig);
  if (!bundle.accessToken || isTokenBundleExpired(bundle)) {
    bundle = await refreshGenericOAuthBundle(
      target,
      authConfig,
      bundle,
      authStore,
      state.generation,
    );
  }
  if (!bundle.accessToken || isTokenBundleExpired(bundle)) {
    throw new CapletsError("AUTH_REFRESH_FAILED", `OAuth token for ${target.server} is expired`, {
      server: target.server,
      backend: target.backend,
      authType: authConfig.type,
      nextAction: "run_caplets_auth_login",
    });
  }
  return { authorization: `${bundle.tokenType ?? "Bearer"} ${bundle.accessToken}` };
}

export async function refreshOAuthTokenBundle(
  target: CapletServerConfig | GenericAuthTarget,
  authStoreInput: BackendAuthStoreInput,
): Promise<StoredOAuthTokenBundle> {
  if (target.auth?.type !== "oauth2" && target.auth?.type !== "oidc") {
    throw new CapletsError("AUTH_REFRESH_FAILED", `${target.server} is not configured for OAuth`, {
      server: target.server,
    });
  }
  const authStore = requireBackendAuthStore(authStoreInput);
  const genericTarget = authRefreshTarget(target);
  const authConfig = target.auth as OAuthLikeAuthConfig;
  const state = await authStore.readTokenBundle(target.server);
  if (!state?.bundle.refreshToken) {
    throw new CapletsError(
      "AUTH_REFRESH_FAILED",
      `OAuth refresh token required for ${target.server}`,
      {
        server: target.server,
        backend: genericTarget.backend,
        authType: authConfig.type,
        nextAction: "run_caplets_auth_login",
      },
    );
  }
  const bundle = state.bundle;
  const normalized = stripUndefined({
    ...bundle,
    server: target.server,
    authType: bundle.authType ?? authConfig.type,
    clientId: bundle.clientId ?? authConfig.clientId ?? authConfig.clientMetadataUrl,
    clientSecret: bundle.clientSecret ?? authConfig.clientSecret,
    protectedResourceOrigin:
      bundle.protectedResourceOrigin ?? protectedResourceOrigin(genericTarget, authConfig),
  }) as StoredOAuthTokenBundle;
  assertTokenBundleMatchesTarget(normalized, genericTarget, authConfig);
  return refreshGenericOAuthBundle(
    genericTarget,
    authConfig,
    normalized,
    authStore,
    state.generation,
  );
}

function authRefreshTarget(target: CapletServerConfig | GenericAuthTarget): GenericAuthTarget {
  if (target.backend !== "mcp") {
    return target;
  }
  return {
    server: target.server,
    backend: "http",
    ...(target.url ? { url: target.url } : {}),
    ...(target.auth ? { auth: target.auth } : {}),
    requestTimeoutMs: target.callTimeoutMs,
  };
}

export const BACKEND_AUTH_FLOW_STATE_VERSION = 1;
export const DEFAULT_BACKEND_AUTH_FLOW_TTL_MS = 10 * 60_000;

type BackendAuthFlowStateBase = {
  version: 1;
  flowId: string;
  server: string;
  redirectUri: string;
  stateVerifier: string;
  pkceVerifier: string;
  startingBackendAuthGeneration: number;
  createdAt: string;
  expiresAt: string;
  configurationFingerprint: string;
};

export type McpBackendAuthFlowState = BackendAuthFlowStateBase & {
  provider: "mcp";
  discovery: OAuthDiscoveryState;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
};

export type GenericBackendAuthFlowState = BackendAuthFlowStateBase & {
  provider: "generic";
  backend: GenericAuthTarget["backend"];
  authType: "oauth2" | "oidc";
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | undefined;
  scope?: string | undefined;
  issuer?: string | undefined;
  allowLoopbackHttp: boolean;
  protectedResourceOrigin?: string | undefined;
};

export type BackendAuthFlowState = McpBackendAuthFlowState | GenericBackendAuthFlowState;

export type BackendAuthCompletionCorrelation = {
  flowId: string;
  completionCorrelation: string;
};

export type BackendAuthCompletionPersistence = (
  bundle: StoredOAuthTokenBundle,
  options: BackendAuthMutationOptions,
) => Promise<StoredOAuthTokenBundleView>;

export function backendAuthCompletionCorrelation(
  bundle: StoredOAuthTokenBundle,
): BackendAuthCompletionCorrelation | undefined {
  const value = bundle.metadata?.backendAuthFlow;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.flowId === "string" && typeof candidate.completionCorrelation === "string"
    ? {
        flowId: candidate.flowId,
        completionCorrelation: candidate.completionCorrelation,
      }
    : undefined;
}
type DurableOAuthStartOptions = {
  flowId?: string | undefined;
  now?: Date | undefined;
  expiresAt?: Date | undefined;
  persist?: ((state: BackendAuthFlowState) => Promise<void>) | undefined;
};

export class FileOAuthProvider implements OAuthClientProvider {
  private verifier: string;
  private readonly stateValue: string;
  private bundle: StoredOAuthTokenBundle | undefined;
  private generation: number | undefined;
  private clientInfo: OAuthClientInformationMixed | undefined;
  private discoveryStateValue: OAuthDiscoveryState | undefined;
  readonly clientMetadataUrl?: string;

  constructor(
    readonly server: CapletServerConfig,
    readonly redirectUrl: string,
    private readonly onRedirect: (url: URL) => void,
    private readonly authStore?: BackendAuthStateStore | string,
    initialState?: StoredOAuthTokenBundleView,
    private readonly options: {
      ignoreLegacyDynamicTokens?: boolean;
      operatorClientId?: string;
      stateValue?: string;
      codeVerifier?: string;
      clientInformation?: OAuthClientInformationMixed;
      discoveryState?: OAuthDiscoveryState;
      initialGeneration?: number;
      completionCorrelation?: string;
      flowId?: string;
      persistTokenBundle?: BackendAuthCompletionPersistence;
    } = {},
  ) {
    this.bundle = initialState?.bundle;
    this.generation = options.initialGeneration ?? initialState?.generation;
    this.verifier = options.codeVerifier ?? base64url(randomBytes(32));
    this.stateValue = options.stateValue ?? base64url(randomBytes(24));
    this.clientInfo = options.clientInformation;
    this.discoveryStateValue = options.discoveryState;
    if (
      (this.server.auth?.type === "oauth2" || this.server.auth?.type === "oidc") &&
      this.server.auth.clientMetadataUrl
    ) {
      this.clientMetadataUrl = this.server.auth.clientMetadataUrl;
    }
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Caplets",
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method:
        (this.server.auth?.type === "oauth2" || this.server.auth?.type === "oidc") &&
        this.server.auth.clientSecret
          ? "client_secret_post"
          : "none",
      ...((this.server.auth?.type === "oauth2" || this.server.auth?.type === "oidc") &&
      this.server.auth.clientId
        ? { client_id: this.server.auth.clientId }
        : {}),
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.clientInfo) {
      return this.clientInfo;
    }
    if (
      (this.server.auth?.type === "oauth2" || this.server.auth?.type === "oidc") &&
      this.server.auth.clientId
    ) {
      return {
        ...this.clientMetadata,
        client_id: this.server.auth.clientId,
        ...(this.server.auth.clientSecret ? { client_secret: this.server.auth.clientSecret } : {}),
      };
    }
    if (this.bundle?.clientId) {
      return {
        ...this.clientMetadata,
        client_id: this.bundle.clientId,
        ...(this.bundle.clientSecret ? { client_secret: this.bundle.clientSecret } : {}),
      };
    }
    return undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.clientInfo = clientInformation;
  }

  tokens(): OAuthTokens | undefined {
    const bundle = this.bundle;
    if (!bundle) {
      return undefined;
    }
    if (this.options.ignoreLegacyDynamicTokens && this.isLegacyDynamicTokenBundle(bundle)) {
      return undefined;
    }
    return stripUndefined({
      access_token: bundle.accessToken,
      token_type: bundle.tokenType,
      refresh_token: bundle.refreshToken,
      expires_in: bundle.expiresAt
        ? Math.max(0, Math.floor((Date.parse(bundle.expiresAt) - Date.now()) / 1000))
        : undefined,
      scope: bundle.scope,
    }) as OAuthTokens;
  }

  private isLegacyDynamicTokenBundle(bundle: StoredOAuthTokenBundle): boolean {
    return Boolean(
      (this.server.auth?.type === "oauth2" || this.server.auth?.type === "oidc") &&
      !this.server.auth.clientId &&
      !this.server.auth.clientMetadataUrl &&
      !bundle.clientId &&
      (bundle.accessToken || bundle.refreshToken),
    );
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const clientInformation = this.clientInformation();
    const bundle = stripUndefined({
      server: this.server.server,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type,
      expiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined,
      scope: tokens.scope,
      clientId: clientInformation?.client_id,
      clientSecret: clientInformation?.client_secret,
      ...(this.options.flowId && this.options.completionCorrelation
        ? {
            metadata: {
              backendAuthFlow: {
                flowId: this.options.flowId,
                completionCorrelation: this.options.completionCorrelation,
              },
            },
          }
        : {}),
    });
    const mutationOptions = {
      expectedGeneration: this.generation,
      ...(this.options.operatorClientId ? { operatorClientId: this.options.operatorClientId } : {}),
    };
    const persisted = this.options.persistTokenBundle
      ? await this.options.persistTokenBundle(bundle, mutationOptions)
      : await requireBackendAuthStore(this.authStore).writeTokenBundle(bundle, mutationOptions);
    this.bundle = persisted.bundle;
    this.generation = persisted.generation;
  }

  tokenBundleView(): StoredOAuthTokenBundleView | undefined {
    return this.bundle && this.generation !== undefined
      ? { bundle: this.bundle, generation: this.generation }
      : undefined;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discoveryStateValue = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discoveryStateValue;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onRedirect(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  addClientAuthentication = async (headers: Headers, params: URLSearchParams): Promise<void> => {
    if (this.server.auth?.type !== "oauth2" && this.server.auth?.type !== "oidc") {
      return;
    }
    const clientInformation = this.clientInformation();
    const clientId = clientInformation?.client_id;
    const clientSecret = clientInformation?.client_secret;
    if (clientId) {
      params.set("client_id", clientId);
    }
    if (clientSecret) {
      params.set("client_secret", clientSecret);
    }
    headers.set("content-type", "application/x-www-form-urlencoded");
  };
}

export type StartedOAuthFlow = {
  authorizationUrl: string;
  state?: BackendAuthFlowState | undefined;
  complete(callbackUrl: string): Promise<void>;
};

export async function startOAuthFlowState(
  server: CapletServerConfig,
  options: {
    redirectUri: string;
    authStore?: BackendAuthStateStore;
    authDir?: string;
    operatorClientId?: string;
    print?: (line: string) => void;
  } & DurableOAuthStartOptions,
): Promise<{ authorizationUrl: string; state?: McpBackendAuthFlowState | undefined }> {
  if (
    server.transport === "stdio" ||
    !server.url ||
    (server.auth?.type !== "oauth2" && server.auth?.type !== "oidc")
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `${server.server} is not a configured OAuth remote server`,
    );
  }

  const authStore = requireBackendAuthStore(options.authStore);
  const authState = await authStore.readState(server.server);
  const initialState = authState.bundle
    ? { bundle: authState.bundle, generation: authState.generation }
    : undefined;
  let redirectUrl: URL | undefined;
  const provider = new FileOAuthProvider(
    server,
    options.redirectUri,
    (url) => {
      redirectUrl = url;
    },
    authStore,
    initialState,
    {
      ignoreLegacyDynamicTokens: true,
      ...(options.operatorClientId ? { operatorClientId: options.operatorClientId } : {}),
    },
  );
  const scope = scopesFor(server.auth);
  try {
    const first = await auth(provider, {
      serverUrl: server.url,
      ...(scope ? { scope } : {}),
    });
    if (first === "AUTHORIZED") return { authorizationUrl: "" };
  } catch (error) {
    throw normalizeMcpOAuthError(server, error);
  }
  if (!redirectUrl) {
    throw new CapletsError("AUTH_FAILED", "OAuth authorization URL was not provided");
  }
  const { flowId, createdAt, expiresAt } = durableFlowIdentity(options);
  const clientInformation = provider.clientInformation();
  const discovery = requireMcpDiscoveryState(provider, server.server);
  const state: McpBackendAuthFlowState = {
    version: BACKEND_AUTH_FLOW_STATE_VERSION,
    flowId,
    server: server.server,
    provider: "mcp",
    redirectUri: options.redirectUri,
    stateVerifier: provider.state(),
    pkceVerifier: provider.codeVerifier(),
    configurationFingerprint: mcpOAuthConfigurationFingerprint(
      server,
      options.redirectUri,
      discovery,
    ),
    startingBackendAuthGeneration: authState.generation,
    ...(clientInformation?.client_id ? { clientId: clientInformation.client_id } : {}),
    ...(clientInformation?.client_secret ? { clientSecret: clientInformation.client_secret } : {}),
    discovery,
    createdAt,
    expiresAt,
  };
  await options.persist?.(state);
  options.print?.(`Open this URL to authorize ${server.server}:\n${redirectUrl.toString()}`);
  return { authorizationUrl: redirectUrl.toString(), state };
}

export async function completeOAuthFlowState(
  server: CapletServerConfig,
  state: McpBackendAuthFlowState,
  callbackUrl: string,
  options: {
    authStore?: BackendAuthStateStore;
    operatorClientId?: string | undefined;
    correlation?: BackendAuthCompletionCorrelation | undefined;
    persistTokenBundle?: BackendAuthCompletionPersistence | undefined;
    now?: Date | undefined;
  },
): Promise<StoredOAuthTokenBundleView> {
  const authConfig = assertMcpFlowState(server, state, options.now ?? new Date());
  if (options.correlation && options.correlation.flowId !== state.flowId) {
    throw new CapletsError("REQUEST_INVALID", "OAuth completion correlation does not match flow.");
  }
  assertNoOAuthCallbackError(server, callbackUrl);
  const completion = extractCompletion(callbackUrl);
  if (completion.state !== state.stateVerifier) throw oauthStateMismatchError(server.server);
  const provider = new FileOAuthProvider(
    server,
    state.redirectUri,
    () => {},
    options.authStore,
    undefined,
    {
      stateValue: state.stateVerifier,
      codeVerifier: state.pkceVerifier,
      initialGeneration: state.startingBackendAuthGeneration,
      discoveryState: state.discovery,
      ...(options.correlation
        ? {
            flowId: options.correlation.flowId,
            completionCorrelation: options.correlation.completionCorrelation,
          }
        : {}),
      ...(state.clientId
        ? {
            clientInformation: {
              client_id: state.clientId,
              ...(state.clientSecret ? { client_secret: state.clientSecret } : {}),
            } as OAuthClientInformationMixed,
          }
        : {}),
      ...(options.operatorClientId ? { operatorClientId: options.operatorClientId } : {}),
      ...(options.persistTokenBundle ? { persistTokenBundle: options.persistTokenBundle } : {}),
    },
  );
  const scope = scopesFor(authConfig);
  try {
    await auth(provider, {
      serverUrl: server.url!,
      authorizationCode: completion.code,
      ...(scope ? { scope } : {}),
    });
  } catch (error) {
    throw normalizeMcpOAuthError(server, error);
  }
  const persisted = provider.tokenBundleView();
  if (!persisted) {
    throw new CapletsError("AUTH_FAILED", "OAuth completion did not persist credentials.");
  }
  return persisted;
}

export async function startOAuthFlow(
  server: CapletServerConfig,
  options: {
    redirectUri: string;
    authStore?: BackendAuthStateStore;
    authDir?: string;
    operatorClientId?: string;
    print?: (line: string) => void;
  } & DurableOAuthStartOptions,
): Promise<StartedOAuthFlow> {
  const started = await startOAuthFlowState(server, options);
  if (!started.state) return { authorizationUrl: "", complete: async () => {} };
  const state = started.state;
  return {
    authorizationUrl: started.authorizationUrl,
    state,
    complete: async (callbackUrl: string) => {
      await completeOAuthFlowState(server, state, callbackUrl, {
        ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
        ...(options.operatorClientId ? { operatorClientId: options.operatorClientId } : {}),
      });
    },
  };
}

export async function runOAuthFlow(
  server: CapletServerConfig,
  options: {
    noOpen?: boolean;
    authStore?: BackendAuthStateStore;
    authDir?: string;
    operatorClientId?: string;
    manualInput?: string;
    readManualInput?: () => Promise<string | undefined>;
    open?: (url: string) => Promise<void>;
    print?: (line: string) => void;
  },
): Promise<AuthResult> {
  const authStore = requireBackendAuthStore(options.authStore);
  let callbackCode: string | undefined;
  let callbackState: string | undefined;
  const callback = await createLoopbackCallback((url) => {
    if (url.searchParams.get("error")) {
      throw new CapletsError(
        "AUTH_FAILED",
        "OAuth provider returned an error",
        redactSecrets(Object.fromEntries(url.searchParams)),
      );
    }
    callbackCode = url.searchParams.get("code") ?? undefined;
    callbackState = url.searchParams.get("state") ?? undefined;
  });

  try {
    const started = await startOAuthFlow(server, {
      redirectUri: callback.redirectUri,
      authStore,
      ...(options.operatorClientId ? { operatorClientId: options.operatorClientId } : {}),
      ...(options.print ? { print: options.print } : {}),
    });
    if (!started.authorizationUrl) {
      return "AUTHORIZED";
    }

    if (!options.noOpen) {
      await (options.open
        ? options.open(started.authorizationUrl)
        : openBrowser(started.authorizationUrl));
    }

    const manualInput =
      options.manualInput ?? (options.noOpen ? await options.readManualInput?.() : undefined);
    const completion = manualInput
      ? extractCompletion(manualInput)
      : await callback.waitForCode(() =>
          callbackCode
            ? {
                code: callbackCode,
                ...(callbackState ? { state: callbackState } : {}),
              }
            : undefined,
        );
    await started.complete(
      completion.state
        ? `${callback.redirectUri}?code=${encodeURIComponent(completion.code)}&state=${encodeURIComponent(completion.state)}`
        : `${callback.redirectUri}?code=${encodeURIComponent(completion.code)}`,
    );
    return "AUTHORIZED";
  } catch (error) {
    throw normalizeMcpOAuthError(server, error);
  } finally {
    await callback.close();
  }
}

function assertNoOAuthCallbackError(target: { server: string }, callbackUrl: string): void {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return;
  }
  const error = url.searchParams.get("error");
  if (!error) {
    return;
  }
  const description = url.searchParams.get("error_description");
  throw new CapletsError(
    "AUTH_FAILED",
    description
      ? `OAuth provider returned an error: ${description}`
      : "OAuth provider returned an error",
    redactSecrets({ server: target.server, error, error_description: description ?? undefined }),
  );
}

function normalizeMcpOAuthError(server: CapletServerConfig, error: unknown): unknown {
  if (
    (server.auth?.type === "oauth2" || server.auth?.type === "oidc") &&
    !server.auth.clientId &&
    !server.auth.clientMetadataUrl &&
    error instanceof Error &&
    // Matched from the MCP SDK dynamic-registration error text; update if the SDK changes it.
    error.message.includes("does not support dynamic client registration")
  ) {
    return new CapletsError(
      "AUTH_FAILED",
      "OAuth is not available for this server without a host-specific OAuth app or PAT auth",
      {
        server: server.server,
        nextAction: "configure_bearer_auth_or_host_oauth_app",
      },
    );
  }
  return error;
}

function durableFlowIdentity(options: DurableOAuthStartOptions): {
  flowId: string;
  createdAt: string;
  expiresAt: string;
} {
  const now = options.now ?? new Date();
  const expiresAt = options.expiresAt ?? new Date(now.getTime() + DEFAULT_BACKEND_AUTH_FLOW_TTL_MS);
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= now.getTime()
  ) {
    throw new CapletsError("REQUEST_INVALID", "OAuth flow expiry must be in the future.");
  }
  const flowId = options.flowId ?? randomUUID();
  if (!flowId.trim() || flowId.length > 512) {
    throw new CapletsError("REQUEST_INVALID", "OAuth flow ID is invalid.");
  }
  return {
    flowId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function assertMcpFlowState(
  server: CapletServerConfig,
  state: McpBackendAuthFlowState,
  now: Date,
): OAuthLikeAuthConfig {
  if (
    server.transport === "stdio" ||
    !server.url ||
    (server.auth?.type !== "oauth2" && server.auth?.type !== "oidc")
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `${server.server} is not a configured OAuth remote server`,
    );
  }
  assertCommonFlowState(state, "mcp", server.server, now);
  if (!state.discovery?.authorizationServerUrl) {
    throw new CapletsError("AUTH_FAILED", "Persisted OAuth discovery state is invalid.", {
      server: server.server,
    });
  }
  if (
    state.configurationFingerprint !==
    mcpOAuthConfigurationFingerprint(server, state.redirectUri, state.discovery)
  ) {
    throw oauthConfigurationChangedError(server.server);
  }
  return server.auth;
}

function assertGenericFlowIdentity(
  target: GenericAuthTarget,
  state: GenericBackendAuthFlowState,
  now: Date,
): void {
  assertCommonFlowState(state, "generic", target.server, now);
  if (state.backend !== target.backend || state.authType !== target.auth?.type) {
    throw oauthConfigurationChangedError(target.server);
  }
}

function assertCommonFlowState(
  state: BackendAuthFlowState,
  provider: BackendAuthFlowState["provider"],
  server: string,
  now: Date,
): void {
  const createdAt = Date.parse(state.createdAt);
  const expiresAt = Date.parse(state.expiresAt);
  if (
    state.version !== BACKEND_AUTH_FLOW_STATE_VERSION ||
    state.provider !== provider ||
    state.server !== server ||
    !state.flowId ||
    !state.redirectUri ||
    !state.stateVerifier ||
    !state.pkceVerifier ||
    !state.configurationFingerprint ||
    !Number.isSafeInteger(state.startingBackendAuthGeneration) ||
    state.startingBackendAuthGeneration < 0 ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    createdAt >= expiresAt
  ) {
    throw new CapletsError("AUTH_FAILED", "Persisted OAuth flow state is invalid.", { server });
  }
  if (!Number.isFinite(now.getTime()) || now.getTime() >= expiresAt) {
    throw new CapletsError("AUTH_FAILED", "OAuth flow has expired.", {
      server,
      flowId: state.flowId,
    });
  }
}

function requireMcpDiscoveryState(
  provider: FileOAuthProvider,
  server: string,
): OAuthDiscoveryState {
  const discovery = provider.discoveryState();
  if (!discovery?.authorizationServerUrl) {
    throw new CapletsError(
      "AUTH_FAILED",
      "OAuth discovery state was not available for durable completion.",
      { server },
    );
  }
  try {
    return JSON.parse(JSON.stringify(discovery)) as OAuthDiscoveryState;
  } catch {
    throw new CapletsError("AUTH_FAILED", "OAuth discovery state was not serializable.", {
      server,
    });
  }
}

function mcpOAuthConfigurationFingerprint(
  server: CapletServerConfig,
  redirectUri: string,
  discovery: OAuthDiscoveryState,
): string {
  const authConfig =
    server.auth?.type === "oauth2" || server.auth?.type === "oidc" ? server.auth : undefined;
  return hashOAuthConfiguration([
    "mcp",
    server.server,
    server.url,
    redirectUri,
    authConfig?.type,
    authConfig?.authorizationUrl,
    authConfig?.tokenUrl,
    authConfig?.issuer,
    authConfig?.resourceMetadataUrl,
    authConfig?.authorizationServerMetadataUrl,
    authConfig?.openidConfigurationUrl,
    authConfig?.clientMetadataUrl,
    authConfig?.clientId,
    authConfig?.clientSecret,
    authConfig?.scopes,
    discovery.authorizationServerUrl,
    discovery.resourceMetadataUrl,
    discovery.authorizationServerMetadata,
    discovery.resourceMetadata,
  ]);
}

function genericOAuthConfigurationFingerprint(input: {
  target: GenericAuthTarget;
  authConfig: OAuthLikeAuthConfig;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  issuer?: string | undefined;
}): string {
  return hashOAuthConfiguration([
    "generic",
    input.target.server,
    input.target.backend,
    input.target.url,
    input.target.baseUrl,
    input.target.specUrl,
    input.target.resolvedScopes,
    input.authConfig.type,
    input.authConfig.authorizationUrl,
    input.authConfig.tokenUrl,
    input.authConfig.issuer,
    input.authConfig.resourceMetadataUrl,
    input.authConfig.authorizationServerMetadataUrl,
    input.authConfig.openidConfigurationUrl,
    input.authConfig.clientMetadataUrl,
    input.authConfig.clientId,
    input.authConfig.clientSecret,
    input.authConfig.scopes,
    input.authorizationEndpoint,
    input.tokenEndpoint,
    input.redirectUri,
    input.issuer,
  ]);
}

function hashOAuthConfiguration(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

function oauthConfigurationChangedError(server: string): CapletsError {
  return new CapletsError(
    "AUTH_FAILED",
    "OAuth configuration changed after authorization started. Re-run auth login.",
    { server, nextAction: "run_caplets_auth_login" },
  );
}

type AuthorizationServerMetadata = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  [key: string]: unknown;
};

export async function startGenericOAuthFlowState(
  target: GenericAuthTarget,
  options: {
    redirectUri: string;
    authStore?: BackendAuthStateStore;
    authDir?: string;
    operatorClientId?: string;
    print?: (line: string) => void;
  } & DurableOAuthStartOptions,
): Promise<{ authorizationUrl: string; state: GenericBackendAuthFlowState }> {
  if (target.auth?.type !== "oauth2" && target.auth?.type !== "oidc") {
    throw new CapletsError("REQUEST_INVALID", `${target.server} is not configured for OAuth`);
  }
  const authStore = requireBackendAuthStore(options.authStore);
  const authConfig = target.auth as OAuthLikeAuthConfig;
  const authState = await authStore.readState(target.server);
  const redirectUri = authConfig.redirectUri ?? options.redirectUri;
  const verifier = base64url(randomBytes(32));
  const stateVerifier = base64url(randomBytes(24));
  const allowLoopbackHttp = isLoopbackDevelopmentTarget(target, authConfig);
  const metadata = await discoverAuthorizationServer(target, authConfig, allowLoopbackHttp);
  const authorizationEndpoint = authConfig.authorizationUrl ?? metadata.authorization_endpoint;
  const tokenEndpoint = authConfig.tokenUrl ?? metadata.token_endpoint;
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new CapletsError("AUTH_FAILED", "OAuth metadata is missing endpoints", {
      server: target.server,
    });
  }
  assertAllowedAuthUrl(authorizationEndpoint, "authorization endpoint", allowLoopbackHttp);
  assertAllowedAuthUrl(tokenEndpoint, "token endpoint", allowLoopbackHttp);
  const client = await resolveGenericClient(
    target,
    authConfig,
    metadata,
    redirectUri,
    allowLoopbackHttp,
  );
  const scope = scopesFor(authConfig, target.resolvedScopes);
  const authorizationUrl = new URL(authorizationEndpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", client.clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("state", stateVerifier);
  if (scope) authorizationUrl.searchParams.set("scope", scope);
  const { flowId, createdAt, expiresAt } = durableFlowIdentity(options);
  const state: GenericBackendAuthFlowState = {
    version: BACKEND_AUTH_FLOW_STATE_VERSION,
    flowId,
    server: target.server,
    provider: "generic",
    authType: authConfig.type,
    backend: target.backend,
    startingBackendAuthGeneration: authState.generation,
    redirectUri,
    stateVerifier,
    pkceVerifier: verifier,
    configurationFingerprint: genericOAuthConfigurationFingerprint({
      target,
      authConfig,
      authorizationEndpoint,
      tokenEndpoint,
      redirectUri,
      issuer: metadata.issuer,
    }),
    authorizationEndpoint,
    tokenEndpoint,
    clientId: client.clientId,
    ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
    ...(scope ? { scope } : {}),
    ...(metadata.issuer ? { issuer: metadata.issuer } : {}),
    allowLoopbackHttp,
    ...(protectedResourceOrigin(target, authConfig)
      ? { protectedResourceOrigin: protectedResourceOrigin(target, authConfig) }
      : {}),
    createdAt,
    expiresAt,
  };
  await options.persist?.(state);
  options.print?.(`Open this URL to authorize ${target.server}:\n${authorizationUrl.toString()}`);
  return { authorizationUrl: authorizationUrl.toString(), state };
}

export async function completeGenericOAuthFlowState(
  target: GenericAuthTarget,
  state: GenericBackendAuthFlowState,
  callbackUrl: string,
  options: {
    authStore?: BackendAuthStateStore;
    operatorClientId?: string | undefined;
    correlation?: BackendAuthCompletionCorrelation | undefined;
    persistTokenBundle?: BackendAuthCompletionPersistence | undefined;
    now?: Date | undefined;
  },
): Promise<StoredOAuthTokenBundleView> {
  if (target.auth?.type !== "oauth2" && target.auth?.type !== "oidc") {
    throw new CapletsError("REQUEST_INVALID", `${target.server} is not configured for OAuth`);
  }
  assertGenericFlowIdentity(target, state, options.now ?? new Date());
  if (options.correlation && options.correlation.flowId !== state.flowId) {
    throw new CapletsError("REQUEST_INVALID", "OAuth completion correlation does not match flow.");
  }
  assertNoOAuthCallbackError(target, callbackUrl);
  const completion = extractCompletion(callbackUrl);
  if (completion.state !== state.stateVerifier) throw oauthStateMismatchError(target.server);
  const authConfig = target.auth as OAuthLikeAuthConfig;
  const allowLoopbackHttp = isLoopbackDevelopmentTarget(target, authConfig);
  const metadata = await discoverAuthorizationServer(target, authConfig, allowLoopbackHttp);
  const authorizationEndpoint = authConfig.authorizationUrl ?? metadata.authorization_endpoint;
  const tokenEndpoint = authConfig.tokenUrl ?? metadata.token_endpoint;
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new CapletsError("AUTH_FAILED", "OAuth metadata is missing endpoints", {
      server: target.server,
    });
  }
  assertAllowedAuthUrl(authorizationEndpoint, "authorization endpoint", allowLoopbackHttp);
  assertAllowedAuthUrl(tokenEndpoint, "token endpoint", allowLoopbackHttp);
  const fingerprint = genericOAuthConfigurationFingerprint({
    target,
    authConfig,
    authorizationEndpoint,
    tokenEndpoint,
    redirectUri: state.redirectUri,
    issuer: metadata.issuer,
  });
  if (
    fingerprint !== state.configurationFingerprint ||
    authorizationEndpoint !== state.authorizationEndpoint ||
    tokenEndpoint !== state.tokenEndpoint ||
    allowLoopbackHttp !== state.allowLoopbackHttp
  ) {
    throw oauthConfigurationChangedError(target.server);
  }
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: completion.code,
    redirect_uri: state.redirectUri,
    client_id: state.clientId,
    code_verifier: state.pkceVerifier,
  });
  if (state.clientSecret) params.set("client_secret", state.clientSecret);
  const tokenResponse = await fetchJson(
    state.tokenEndpoint,
    target.requestTimeoutMs,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
    state.allowLoopbackHttp,
  );
  const idToken = asString(tokenResponse.id_token);
  const idClaims = parseJwtPayload(idToken);
  validateOidcToken(authConfig, metadata, idToken, idClaims, state.clientId);
  const bundle = stripUndefined({
    server: target.server,
    authType: state.authType,
    accessToken: requireString(tokenResponse.access_token, "access_token"),
    refreshToken: asString(tokenResponse.refresh_token),
    tokenType: asString(tokenResponse.token_type),
    expiresAt:
      typeof tokenResponse.expires_in === "number"
        ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
        : undefined,
    scope: asString(tokenResponse.scope) ?? state.scope,
    idToken,
    issuer: asString(idClaims?.iss) ?? metadata.issuer ?? authConfig.issuer,
    subject: asString(idClaims?.sub),
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    protectedResourceOrigin: state.protectedResourceOrigin,
    metadata: {
      ...(redactSecrets({
        protectedResource: target.url ?? target.baseUrl ?? target.specUrl,
        authorizationServer: metadata,
        requestedScopes: state.scope?.split(/\s+/u).filter(Boolean),
        dynamicClient: authConfig.clientId ? undefined : { client_id: state.clientId },
      }) as Record<string, unknown>),
      ...(options.correlation ? { backendAuthFlow: options.correlation } : {}),
    },
  });
  const mutationOptions = {
    expectedGeneration: state.startingBackendAuthGeneration,
    ...(options.operatorClientId ? { operatorClientId: options.operatorClientId } : {}),
  };
  return options.persistTokenBundle
    ? await options.persistTokenBundle(bundle, mutationOptions)
    : await requireBackendAuthStore(options.authStore).writeTokenBundle(bundle, mutationOptions);
}

export async function startGenericOAuthFlow(
  target: GenericAuthTarget,
  options: {
    redirectUri: string;
    authStore?: BackendAuthStateStore;
    authDir?: string;
    operatorClientId?: string;
    print?: (line: string) => void;
  } & DurableOAuthStartOptions,
): Promise<StartedOAuthFlow> {
  const started = await startGenericOAuthFlowState(target, options);
  const state = started.state;
  return {
    authorizationUrl: started.authorizationUrl,
    state,
    complete: async (callbackUrl: string) => {
      await completeGenericOAuthFlowState(target, state, callbackUrl, {
        ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
        ...(options.operatorClientId ? { operatorClientId: options.operatorClientId } : {}),
      });
    },
  };
}

export async function runGenericOAuthFlow(
  target: GenericAuthTarget,
  options: {
    noOpen?: boolean;
    authStore?: BackendAuthStateStore;
    authDir?: string;
    operatorClientId?: string;
    manualInput?: string;
    readManualInput?: () => Promise<string | undefined>;
    open?: (url: string) => Promise<void>;
    print?: (line: string) => void;
  },
): Promise<StoredOAuthTokenBundle> {
  const authStore = requireBackendAuthStore(options.authStore);
  let callbackCode: string | undefined;
  let callbackState: string | undefined;
  const callback = await createLoopbackCallback((url) => {
    if (url.searchParams.get("error")) {
      throw new CapletsError(
        "AUTH_FAILED",
        "OAuth provider returned an error",
        redactSecrets(Object.fromEntries(url.searchParams)),
      );
    }
    callbackCode = url.searchParams.get("code") ?? undefined;
    callbackState = url.searchParams.get("state") ?? undefined;
  });
  try {
    const started = await startGenericOAuthFlowState(target, {
      redirectUri: callback.redirectUri,
      authStore,
      ...(options.operatorClientId ? { operatorClientId: options.operatorClientId } : {}),
      ...(options.print ? { print: options.print } : {}),
    });
    if (!options.noOpen) {
      await (options.open
        ? options.open(started.authorizationUrl)
        : openBrowser(started.authorizationUrl));
    }
    const manualInput =
      options.manualInput ?? (options.noOpen ? await options.readManualInput?.() : undefined);
    const completion = manualInput
      ? extractCompletion(manualInput)
      : await callback.waitForCode(() =>
          callbackCode
            ? {
                code: callbackCode,
                ...(callbackState ? { state: callbackState } : {}),
              }
            : undefined,
        );
    const callbackUrl = completion.state
      ? `${started.state.redirectUri}?code=${encodeURIComponent(completion.code)}&state=${encodeURIComponent(completion.state)}`
      : `${started.state.redirectUri}?code=${encodeURIComponent(completion.code)}`;
    const persisted = await completeGenericOAuthFlowState(target, started.state, callbackUrl, {
      authStore,
      ...(options.operatorClientId ? { operatorClientId: options.operatorClientId } : {}),
    });
    return persisted.bundle;
  } finally {
    await callback.close();
  }
}

export function extractCompletion(input: string): { code: string; state?: string } {
  try {
    const url = new URL(stripOAuthCallbackUrlWrapping(input));
    const code = extractOAuthCallbackParam(url, "code");
    const state = extractOAuthCallbackParam(url, "state");
    if (!code) {
      throw new Error("missing code");
    }
    return state ? { code, state } : { code };
  } catch {
    return { code: input.trim() };
  }
}

function stripOAuthCallbackUrlWrapping(input: string): string {
  return input.replace(/\s+/g, "");
}

function extractOAuthCallbackParam(url: URL, name: "code" | "state"): string | undefined {
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  for (const part of query.split("&")) {
    const separator = part.indexOf("=");
    const rawName = separator < 0 ? part : part.slice(0, separator);
    const rawValue = separator < 0 ? "" : part.slice(separator + 1);
    if (decodeOAuthCallbackQueryValue(rawName) === name) {
      const value = decodeOAuthCallbackQueryValue(rawValue);
      return value || undefined;
    }
  }
  return undefined;
}

function decodeOAuthCallbackQueryValue(value: string): string {
  return decodeURIComponent(value);
}

function oauthStateMismatchError(server: string): CapletsError {
  return new CapletsError(
    "AUTH_FAILED",
    "OAuth callback state did not match. Re-run auth login and use the authorization URL and callback URL from the same attempt.",
    {
      server,
      nextAction: "rerun_caplets_auth_login",
    },
  );
}

export function classifyRemoteAuthError(
  server: CapletServerConfig,
  response: Response,
): CapletsError | undefined {
  if (response.status !== 401 && response.status !== 403) {
    return undefined;
  }
  const challenge = extractWWWAuthenticateParams(response);
  return new CapletsError(
    response.status === 401 ? "AUTH_REQUIRED" : "AUTH_FAILED",
    "Remote MCP authentication failed",
    {
      server: server.server,
      status: response.status,
      message: response.statusText,
      authType: server.auth?.type ?? "none",
      challenge: redactSecrets(challenge),
      ...(server.auth?.type === "oauth2" || server.auth?.type === "oidc"
        ? { nextAction: "run_caplets_auth_login" }
        : {}),
    },
  );
}

async function createLoopbackCallback(onCallback: (url: URL) => void) {
  let resolveCode: (() => void) | undefined;
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      onCallback(url);
      res.end("Caplets authentication complete. You can close this tab.");
      resolveCode?.();
    } catch {
      res.statusCode = 400;
      res.end("Caplets authentication failed.");
      resolveCode?.();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new CapletsError("AUTH_FAILED", "Could not create OAuth callback listener");
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode: async (read: () => { code: string; state?: string } | undefined) => {
      while (!read()) {
        await new Promise<void>((resolve) => {
          resolveCode = resolve;
          setTimeout(resolve, 100);
        });
      }
      return read()!;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function discoverAuthorizationServer(
  target: GenericAuthTarget,
  authConfig: OAuthLikeAuthConfig,
  allowLoopbackHttp: boolean,
): Promise<AuthorizationServerMetadata> {
  if (authConfig.authorizationUrl && authConfig.tokenUrl) {
    return {
      ...(authConfig.issuer ? { issuer: authConfig.issuer } : {}),
      authorization_endpoint: authConfig.authorizationUrl,
      token_endpoint: authConfig.tokenUrl,
    };
  }
  const resource = target.url ?? target.baseUrl ?? target.specUrl ?? authConfig.issuer;
  const resourceOrigin = resource ? new URL(resource).origin : undefined;
  const protectedMetadata =
    (authConfig.resourceMetadataUrl
      ? ((await fetchJson(
          authConfig.resourceMetadataUrl,
          target.requestTimeoutMs,
          {},
          allowLoopbackHttp,
        )) as AuthorizationServerMetadata)
      : undefined) ??
    (resourceOrigin
      ? await fetchOptionalJson(
          `${resourceOrigin}/.well-known/oauth-protected-resource`,
          target.requestTimeoutMs,
          allowLoopbackHttp,
        )
      : undefined);
  const authorizationServer =
    authConfig.issuer ??
    asString((protectedMetadata?.authorization_servers as unknown[] | undefined)?.[0]) ??
    resourceOrigin;
  if (!authorizationServer) {
    throw new CapletsError("AUTH_FAILED", "OAuth authorization server could not be discovered", {
      server: target.server,
    });
  }
  return (
    (authConfig.authorizationServerMetadataUrl
      ? ((await fetchJson(
          authConfig.authorizationServerMetadataUrl,
          target.requestTimeoutMs,
          {},
          allowLoopbackHttp,
        )) as AuthorizationServerMetadata)
      : undefined) ??
    (await fetchOptionalJson(
      oauthAuthorizationServerMetadataUrl(authorizationServer, allowLoopbackHttp),
      target.requestTimeoutMs,
      allowLoopbackHttp,
    )) ??
    (authConfig.openidConfigurationUrl
      ? ((await fetchJson(
          authConfig.openidConfigurationUrl,
          target.requestTimeoutMs,
          {},
          allowLoopbackHttp,
        )) as AuthorizationServerMetadata)
      : undefined) ??
    (await fetchOptionalJson(
      openIdConfigurationUrl(authorizationServer, allowLoopbackHttp),
      target.requestTimeoutMs,
      allowLoopbackHttp,
    )) ??
    {}
  );
}

async function resolveGenericClient(
  target: GenericAuthTarget,
  authConfig: OAuthLikeAuthConfig,
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
  allowLoopbackHttp: boolean,
): Promise<{ clientId: string; clientSecret?: string; dynamic: boolean }> {
  if (authConfig.clientId) {
    return {
      clientId: authConfig.clientId,
      ...(authConfig.clientSecret ? { clientSecret: authConfig.clientSecret } : {}),
      dynamic: false,
    };
  }
  if (authConfig.clientMetadataUrl) {
    return {
      clientId: authConfig.clientMetadataUrl,
      ...(authConfig.clientSecret ? { clientSecret: authConfig.clientSecret } : {}),
      dynamic: false,
    };
  }
  if (!metadata.registration_endpoint) {
    throw new CapletsError(
      "AUTH_FAILED",
      "OAuth clientId is required without dynamic registration",
      {
        server: target.server,
      },
    );
  }
  const response = await fetchJson(
    metadata.registration_endpoint,
    target.requestTimeoutMs,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Caplets",
        redirect_uris: [redirectUri],
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      }),
    },
    allowLoopbackHttp,
  );
  const clientSecret = asString(response.client_secret);
  return {
    clientId: requireString(response.client_id, "client_id"),
    ...(clientSecret ? { clientSecret } : {}),
    dynamic: true,
  };
}

function requireBackendAuthStore(input: BackendAuthStoreInput): BackendAuthStateStore {
  if (input && typeof input !== "string") return input;
  throw new CapletsError(
    "REQUEST_INVALID",
    "Backend OAuth state requires Authoritative Host State storage.",
  );
}

async function refreshGenericOAuthBundle(
  target: GenericAuthTarget,
  authConfig: OAuthLikeAuthConfig,
  bundle: StoredOAuthTokenBundle,
  authStore: BackendAuthStateStore,
  expectedGeneration: number,
): Promise<StoredOAuthTokenBundle> {
  if (!bundle.refreshToken) {
    throw new CapletsError("AUTH_REFRESH_FAILED", `OAuth token for ${target.server} is expired`, {
      server: target.server,
      backend: target.backend,
      authType: authConfig.type,
      nextAction: "run_caplets_auth_login",
    });
  }
  const allowLoopbackHttp = isLoopbackDevelopmentTarget(target, authConfig);
  let metadata: AuthorizationServerMetadata = {};
  let tokenEndpoint = authConfig.tokenUrl;
  if (!tokenEndpoint) {
    metadata = await discoverAuthorizationServer(target, authConfig, allowLoopbackHttp);
    tokenEndpoint = metadata.token_endpoint;
  }
  if (!tokenEndpoint) {
    throw new CapletsError("AUTH_REFRESH_FAILED", "OAuth metadata is missing token endpoint", {
      server: target.server,
      backend: target.backend,
      authType: authConfig.type,
      nextAction: "run_caplets_auth_login",
    });
  }
  assertAllowedAuthUrl(tokenEndpoint, "token endpoint", allowLoopbackHttp);
  const clientId = authConfig.clientId ?? authConfig.clientMetadataUrl ?? bundle.clientId;
  if (!clientId) {
    throw new CapletsError(
      "AUTH_REFRESH_FAILED",
      `OAuth client information is missing for ${target.server}. Re-run caplets auth login ${target.server}.`,
      {
        server: target.server,
        backend: target.backend,
        authType: authConfig.type,
        nextAction: "run_caplets_auth_login",
      },
    );
  }
  const clientSecret = authConfig.clientSecret ?? bundle.clientSecret;
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: bundle.refreshToken,
    client_id: clientId,
  });
  if (clientSecret) {
    params.set("client_secret", clientSecret);
  }
  let tokenResponse: Record<string, unknown>;
  try {
    tokenResponse = await fetchJson(
      tokenEndpoint,
      target.requestTimeoutMs,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      },
      allowLoopbackHttp,
    );
  } catch (error) {
    if (error instanceof CapletsError) {
      throw new CapletsError("AUTH_REFRESH_FAILED", `OAuth token refresh failed`, {
        server: target.server,
        backend: target.backend,
        authType: authConfig.type,
        nextAction: "run_caplets_auth_login",
        cause: error.details,
      });
    }
    throw error;
  }
  const idToken = asString(tokenResponse.id_token);
  const idClaims = parseJwtPayload(idToken);
  if (idToken) {
    if (!metadata.issuer && !authConfig.issuer) {
      metadata = await discoverAuthorizationServer(target, authConfig, allowLoopbackHttp);
    }
    validateOidcToken(authConfig, metadata, idToken, idClaims, clientId);
  }
  const refreshed = stripUndefined({
    ...bundle,
    server: target.server,
    authType: authConfig.type,
    accessToken: requireString(tokenResponse.access_token, "access_token"),
    refreshToken: asString(tokenResponse.refresh_token) ?? bundle.refreshToken,
    tokenType: asString(tokenResponse.token_type) ?? bundle.tokenType,
    expiresAt: refreshedExpiresAt(tokenResponse.expires_in, bundle.expiresAt),
    scope:
      asString(tokenResponse.scope) ?? bundle.scope ?? scopesFor(authConfig, target.resolvedScopes),
    idToken: idToken ?? bundle.idToken,
    issuer: asString(idClaims?.iss) ?? bundle.issuer ?? metadata.issuer ?? authConfig.issuer,
    subject: asString(idClaims?.sub) ?? bundle.subject,
    clientId,
    clientSecret,
    protectedResourceOrigin: protectedResourceOrigin(target, authConfig),
  });
  await authStore.writeTokenBundle(refreshed, { expectedGeneration });
  return refreshed;
}

function refreshedExpiresAt(expiresIn: unknown, fallback?: string): string | undefined {
  if (typeof expiresIn === "number") {
    return new Date(Date.now() + expiresIn * 1000).toISOString();
  }
  if (fallback && Date.parse(fallback) > Date.now()) {
    return fallback;
  }
  return undefined;
}

async function fetchOptionalJson(
  url: string,
  timeoutMs?: number,
  allowLoopbackHttp = false,
): Promise<AuthorizationServerMetadata | undefined> {
  try {
    return (await fetchJson(url, timeoutMs, {}, allowLoopbackHttp)) as AuthorizationServerMetadata;
  } catch {
    return undefined;
  }
}

async function fetchJson(
  url: string,
  timeoutMs = 60_000,
  init: RequestInit = {},
  allowLoopbackHttp = false,
): Promise<Record<string, unknown>> {
  assertAllowedAuthUrl(url, "OAuth discovery URL", allowLoopbackHttp);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    if (!response.ok) {
      throw new CapletsError("AUTH_FAILED", "OAuth metadata request failed", {
        status: response.status,
      });
    }
    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

function oauthAuthorizationServerMetadataUrl(issuer: string, allowLoopbackHttp: boolean): string {
  assertAllowedAuthUrl(issuer, "OAuth issuer", allowLoopbackHttp);
  const url = new URL(issuer);
  const issuerPath = trimSlashes(url.pathname);
  url.pathname = issuerPath
    ? `/.well-known/oauth-authorization-server/${issuerPath}`
    : "/.well-known/oauth-authorization-server";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function openIdConfigurationUrl(issuer: string, allowLoopbackHttp: boolean): string {
  assertAllowedAuthUrl(issuer, "OAuth issuer", allowLoopbackHttp);
  const url = new URL(issuer);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function assertAllowedAuthUrl(value: string, label: string, allowLoopbackHttp = false): void {
  const url = new URL(value);
  if (url.protocol === "https:") {
    return;
  }
  if (allowLoopbackHttp && isLoopbackHttpUrl(value)) {
    return;
  }
  throw new CapletsError("AUTH_FAILED", `${label} must use https except loopback development URLs`);
}

function assertTokenBundleMatchesTarget(
  bundle: StoredOAuthTokenBundle,
  target: GenericAuthTarget,
  authConfig: OAuthLikeAuthConfig,
): void {
  const configuredClientId = authConfig.clientId ?? authConfig.clientMetadataUrl;
  const expectedOrigin = protectedResourceOrigin(target, authConfig);
  const mismatch =
    bundle.authType !== authConfig.type ||
    (expectedOrigin && bundle.protectedResourceOrigin !== expectedOrigin) ||
    (configuredClientId && bundle.clientId !== configuredClientId) ||
    (authConfig.issuer && bundle.issuer !== authConfig.issuer) ||
    tokenBundleMissingScopes(bundle, authConfig, target.resolvedScopes);
  if (mismatch) {
    throw new CapletsError(
      "AUTH_REQUIRED",
      `OAuth credentials for ${target.server} do not match the configured backend`,
      {
        server: target.server,
        backend: target.backend,
        authType: authConfig.type,
        nextAction: "run_caplets_auth_login",
      },
    );
  }
}

function protectedResourceOrigin(
  target: GenericAuthTarget,
  authConfig: OAuthLikeAuthConfig,
): string | undefined {
  const resource = target.url ?? target.baseUrl ?? target.specUrl ?? authConfig.issuer;
  return resource ? new URL(resource).origin : undefined;
}

function isLoopbackDevelopmentTarget(
  target: GenericAuthTarget,
  authConfig: OAuthLikeAuthConfig,
): boolean {
  return Boolean(
    [target.url, target.baseUrl, target.specUrl, authConfig.issuer].some(
      (value) => value && isLoopbackHttpUrl(value),
    ),
  );
}

function isLoopbackHttpUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
  );
}

function tokenBundleMissingScopes(
  bundle: StoredOAuthTokenBundle,
  authConfig: OAuthLikeAuthConfig,
  resolvedScopes: string[] | undefined,
): boolean {
  const required = requiredStoredScopes(authConfig, resolvedScopes);
  if (required.length === 0) return false;
  const metadataScopes = requestedScopesFromMetadata(bundle.metadata);
  const actual = new Set(bundle.scope?.split(/\s+/u).filter(Boolean) ?? metadataScopes ?? []);
  return required.some(
    (scope) => ![...actual].some((grantedScope) => oauthScopeSatisfies(grantedScope, scope)),
  );
}

function oauthScopeSatisfies(grantedScope: string, requiredScope: string): boolean {
  if (grantedScope === requiredScope) return true;
  const googleScopePrefix = "https://www.googleapis.com/auth/";
  if (!grantedScope.startsWith(googleScopePrefix) || !requiredScope.startsWith(googleScopePrefix)) {
    return false;
  }
  return requiredScope.startsWith(`${grantedScope}.`);
}

function requiredStoredScopes(
  authConfig: OAuthLikeAuthConfig,
  resolvedScopes: string[] | undefined,
): string[] {
  if (authConfig.scopes?.length) return authConfig.scopes;
  return resolvedScopes?.length ? [...new Set(resolvedScopes)].sort() : [];
}

function requestedScopesFromMetadata(metadata: unknown): string[] | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).requestedScopes;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function scopesFor(
  authConfig: OAuthLikeAuthConfig,
  resolvedScopes?: string[] | undefined,
): string | undefined {
  if (authConfig.scopes?.length) {
    return authConfig.scopes.join(" ");
  }
  if (resolvedScopes?.length) {
    const apiScopes = [...new Set(resolvedScopes)].sort();
    return authConfig.type === "oidc"
      ? ["openid", "profile", "email", ...apiScopes].join(" ")
      : apiScopes.join(" ");
  }
  return authConfig.type === "oidc" ? "openid profile email" : undefined;
}

function validateOidcToken(
  authConfig: OAuthLikeAuthConfig,
  metadata: AuthorizationServerMetadata,
  idToken: string | undefined,
  claims: Record<string, unknown> | undefined,
  clientId: string,
): void {
  if (authConfig.type !== "oidc") {
    return;
  }
  if (!idToken || !claims) {
    throw new CapletsError("AUTH_FAILED", "OIDC token response is missing a valid id_token");
  }
  const expectedIssuer = metadata.issuer ?? authConfig.issuer;
  if (!expectedIssuer) {
    throw new CapletsError("AUTH_FAILED", "OIDC issuer could not be verified");
  }
  if (claims.iss !== expectedIssuer) {
    throw new CapletsError("AUTH_FAILED", "OIDC issuer did not match discovered metadata");
  }
  if (!oidcAudienceMatches(claims.aud, clientId)) {
    throw new CapletsError("AUTH_FAILED", "OIDC audience did not match the client id");
  }
  if (!asString(claims.sub)) {
    throw new CapletsError("AUTH_FAILED", "OIDC id_token is missing subject");
  }
}

function oidcAudienceMatches(audience: unknown, clientId: string): boolean {
  if (typeof audience === "string") {
    return audience === clientId;
  }
  return Array.isArray(audience) && audience.includes(clientId);
}

function parseJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  const payload = token?.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function requireString(value: unknown, field: string): string {
  const result = asString(value);
  if (!result) {
    throw new CapletsError("AUTH_FAILED", `OAuth response is missing ${field}`);
  }
  return result;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  ) as T;
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}
