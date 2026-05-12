import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import {
  auth,
  type AuthResult,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth";
import { CapletsError, redactSecrets } from "./errors.js";
import type { CapletServerConfig } from "./config.js";

export type StoredOAuthTokenBundle = {
  server: string;
  accessToken: string;
  refreshToken?: string | undefined;
  tokenType?: string | undefined;
  expiresAt?: string | undefined;
  scope?: string | undefined;
  metadata?: Record<string, unknown>;
};

export function authStorePath(
  server: string,
  authDir = join(homedir(), ".caplets", "auth"),
): string {
  return join(authDir, `${server}.json`);
}

export function readTokenBundle(
  server: string,
  authDir?: string,
): StoredOAuthTokenBundle | undefined {
  const path = authStorePath(server, authDir);
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as StoredOAuthTokenBundle;
}

export function listTokenBundles(authDir?: string): StoredOAuthTokenBundle[] {
  const dir = authDir ?? join(homedir(), ".caplets", "auth");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readTokenBundle(entry.name.slice(0, -".json".length), dir))
    .filter((bundle): bundle is StoredOAuthTokenBundle => Boolean(bundle))
    .sort((left, right) => left.server.localeCompare(right.server));
}

export function deleteTokenBundle(server: string, authDir?: string): boolean {
  const path = authStorePath(server, authDir);
  if (!existsSync(path)) {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

export function isTokenBundleExpired(bundle: StoredOAuthTokenBundle): boolean {
  return Boolean(bundle.expiresAt && Date.parse(bundle.expiresAt) <= Date.now());
}

export function writeTokenBundle(bundle: StoredOAuthTokenBundle, authDir?: string): void {
  const path = authStorePath(bundle.server, authDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tempPath, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
  renameSync(tempPath, path);
}

export function staticRemoteHeaders(server: CapletServerConfig): Record<string, string> {
  if (server.auth?.type === "bearer") {
    return { authorization: `Bearer ${server.auth.token}` };
  }
  if (server.auth?.type === "headers") {
    return server.auth.headers;
  }
  return {};
}

export function oauthHeaders(server: CapletServerConfig, authDir?: string): Record<string, string> {
  if (server.auth?.type !== "oauth2") {
    return {};
  }
  const bundle = readTokenBundle(server.server, authDir);
  if (!bundle?.accessToken) {
    throw new CapletsError("AUTH_REQUIRED", `OAuth credentials required for ${server.server}`, {
      server: server.server,
      authType: "oauth2",
      nextAction: "run_caplets_auth_login",
    });
  }
  if (bundle.expiresAt && Date.parse(bundle.expiresAt) <= Date.now()) {
    throw new CapletsError("AUTH_REFRESH_FAILED", `OAuth token for ${server.server} is expired`, {
      server: server.server,
      authType: "oauth2",
      nextAction: "run_caplets_auth_login",
    });
  }
  return { authorization: `${bundle.tokenType ?? "Bearer"} ${bundle.accessToken}` };
}

export class FileOAuthProvider implements OAuthClientProvider {
  private verifier = base64url(randomBytes(32));
  private readonly stateValue = base64url(randomBytes(24));
  private clientInfo?: OAuthClientInformationMixed;

  constructor(
    readonly server: CapletServerConfig,
    readonly redirectUrl: string,
    private readonly onRedirect: (url: URL) => void,
    private readonly authDir?: string,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Caplets",
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method:
        this.server.auth?.type === "oauth2" && this.server.auth.clientSecret
          ? "client_secret_post"
          : "none",
      ...(this.server.auth?.type === "oauth2" && this.server.auth.clientId
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
    if (this.server.auth?.type === "oauth2" && this.server.auth.clientId) {
      return {
        ...this.clientMetadata,
        client_id: this.server.auth.clientId,
        ...(this.server.auth.clientSecret ? { client_secret: this.server.auth.clientSecret } : {}),
      };
    }
    return undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.clientInfo = clientInformation;
  }

  tokens(): OAuthTokens | undefined {
    const bundle = readTokenBundle(this.server.server, this.authDir);
    if (!bundle) {
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

  saveTokens(tokens: OAuthTokens): void {
    writeTokenBundle(
      stripUndefined({
        server: this.server.server,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenType: tokens.token_type,
        expiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : undefined,
        scope: tokens.scope,
      }),
      this.authDir,
    );
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
    if (this.server.auth?.type !== "oauth2" || !this.server.auth.clientSecret) {
      return;
    }
    params.set("client_secret", this.server.auth.clientSecret);
    headers.set("content-type", "application/x-www-form-urlencoded");
  };
}

export async function runOAuthFlow(
  server: CapletServerConfig,
  options: {
    noOpen?: boolean;
    authDir?: string;
    manualInput?: string;
    readManualInput?: () => Promise<string | undefined>;
    open?: (url: string) => Promise<void>;
    print?: (line: string) => void;
  } = {},
): Promise<AuthResult> {
  if (server.transport === "stdio" || !server.url || server.auth?.type !== "oauth2") {
    throw new CapletsError(
      "REQUEST_INVALID",
      `${server.server} is not a configured OAuth remote server`,
    );
  }

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

  let redirectUrl: URL | undefined;
  const provider = new FileOAuthProvider(
    server,
    callback.redirectUri,
    (url) => {
      redirectUrl = url;
      options.print?.(`Open this URL to authorize ${server.server}:\n${url.toString()}`);
    },
    options.authDir,
  );

  try {
    const scope = server.auth.scopes?.join(" ");
    const first = await auth(provider, {
      serverUrl: server.url,
      ...(scope ? { scope } : {}),
    });
    if (first === "AUTHORIZED") {
      return first;
    }

    if (!options.noOpen && redirectUrl) {
      await (options.open
        ? options.open(redirectUrl.toString())
        : openBrowser(redirectUrl.toString()));
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
    const expectedState = provider.state();
    if (completion.state !== expectedState) {
      throw new CapletsError("AUTH_FAILED", "OAuth callback state did not match");
    }
    return await auth(provider, {
      serverUrl: server.url,
      authorizationCode: completion.code,
      ...(scope ? { scope } : {}),
    });
  } finally {
    await callback.close();
  }
}

export function extractCompletion(input: string): { code: string; state?: string } {
  try {
    const url = new URL(input);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? undefined;
    if (!code) {
      throw new Error("missing code");
    }
    return state ? { code, state } : { code };
  } catch {
    return { code: input.trim() };
  }
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
      ...(server.auth?.type === "oauth2" ? { nextAction: "run_caplets_auth_login" } : {}),
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

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  ) as T;
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}
