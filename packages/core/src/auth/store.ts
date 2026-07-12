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
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_AUTH_DIR } from "../config/paths";
import { stableJsonStringify } from "../stable-json";
import type {
  AuthorityCommitResult,
  AuthorityGenerationIdentity,
  AuthorityHead,
  WritableAuthority,
} from "../storage/types";
import {
  decryptVaultValue,
  encryptVaultValue,
  parseEncryptedRecord,
  type VaultEncryptedRecord,
} from "../vault/crypto";
import { loadInjectedVaultKey, vaultKeyFingerprint } from "../vault/keys";
import { CapletsError } from "../errors";

export type StoredOAuthTokenBundle = {
  server: string;
  authType?: "oauth2" | "oidc" | undefined;
  accessToken: string;
  refreshToken?: string | undefined;
  tokenType?: string | undefined;
  expiresAt?: string | undefined;
  scope?: string | undefined;
  idToken?: string | undefined;
  issuer?: string | undefined;
  subject?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  protectedResourceOrigin?: string | undefined;
  metadata?: Record<string, unknown>;
};

export function authStorePath(server: string, authDir = DEFAULT_AUTH_DIR): string {
  if (!server || server.includes("/") || server.includes("\\") || server.includes("..")) {
    throw new CapletsError("REQUEST_INVALID", `Invalid auth store server name ${server}`);
  }
  const authRoot = resolve(authDir);
  const candidate = resolve(authRoot, `${server}.json`);
  const relativePath = relative(authRoot, candidate);
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return candidate;
  }
  throw new CapletsError("REQUEST_INVALID", `Invalid auth store server name ${server}`);
}

export function readTokenBundle(
  server: string,
  authDir?: string,
): StoredOAuthTokenBundle | undefined {
  const path = authStorePath(server, authDir);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredOAuthTokenBundle;
  } catch {
    return undefined;
  }
}

export function listTokenBundles(authDir?: string): StoredOAuthTokenBundle[] {
  const dir = authDir ?? DEFAULT_AUTH_DIR;
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
export type OAuthTokenStore = {
  read(server: string): Promise<StoredOAuthTokenBundle | undefined>;
  list(): Promise<StoredOAuthTokenBundle[]>;
  write(bundle: StoredOAuthTokenBundle): Promise<void>;
  delete(server: string): Promise<boolean>;
};

export class FileOAuthTokenStore implements OAuthTokenStore {
  readonly authDir: string;

  constructor(authDir = DEFAULT_AUTH_DIR) {
    this.authDir = authDir;
  }

  async read(server: string): Promise<StoredOAuthTokenBundle | undefined> {
    return readTokenBundle(server, this.authDir);
  }

  async list(): Promise<StoredOAuthTokenBundle[]> {
    return listTokenBundles(this.authDir);
  }

  async write(bundle: StoredOAuthTokenBundle): Promise<void> {
    writeTokenBundle(bundle, this.authDir);
  }

  async delete(server: string): Promise<boolean> {
    return deleteTokenBundle(server, this.authDir);
  }
}

export { FileOAuthTokenStore as AsyncFileOAuthTokenStore };

export type AuthorityOAuthAuthorization = {
  operation: "read" | "write" | "delete";
  server?: string | undefined;
};

export type AuthorityOAuthTokenStoreOptions = {
  authority: WritableAuthority<unknown, never> & { readonly authorityId?: string | undefined };
  authorityId?: string | undefined;
  currentHostId?: string | undefined;
  principalId?: string | undefined;
  key: string | Uint8Array | undefined;
  authorize?: ((input: AuthorityOAuthAuthorization) => void | Promise<void | boolean>) | undefined;
  now?: (() => Date) | undefined;
};

export type AuthorityOAuthSnapshot = {
  version: 1;
  keyFingerprint: string;
  bundles: Record<string, VaultEncryptedRecord>;
};

/**
 * Async encrypted OAuth/OIDC bundle repository. The authority receives only
 * encrypted bundles and metadata; request callers decrypt the current bundle
 * immediately before use.
 */
export class AuthorityOAuthTokenStore implements OAuthTokenStore {
  readonly authorityId: string;
  private readonly authority: AuthorityOAuthTokenStoreOptions["authority"];
  private readonly key: Buffer;
  private readonly keyFingerprint: string;
  private readonly currentHostId: string;
  private readonly principalId: string;
  private readonly authorize?: AuthorityOAuthTokenStoreOptions["authorize"];
  private readonly now: () => Date;

  constructor(options: AuthorityOAuthTokenStoreOptions) {
    this.authority = options.authority;
    this.authorityId =
      options.authorityId ??
      (typeof options.authority.authorityId === "string"
        ? options.authority.authorityId
        : "authority");
    this.key = loadInjectedVaultKey({ key: options.key, label: "Shared OAuth encryption key" });
    this.keyFingerprint = vaultKeyFingerprint(this.key);
    this.currentHostId = options.currentHostId ?? "current-host";
    this.principalId = options.principalId ?? "oauth";
    this.authorize = options.authorize;
    this.now = options.now ?? (() => new Date());
  }

  async read(server: string): Promise<StoredOAuthTokenBundle | undefined> {
    authStorePath(server);
    await this.ensureAuthorized({ operation: "read", server });
    const current = await this.readState();
    const encrypted = current.bundles[server];
    if (!encrypted) return undefined;
    return parseStoredBundle(decryptVaultValue(encrypted, this.key));
  }

  async list(): Promise<StoredOAuthTokenBundle[]> {
    await this.ensureAuthorized({ operation: "read" });
    const current = await this.readState();
    return Object.entries(current.bundles)
      .map(([server, encrypted]) => {
        const bundle = parseStoredBundle(decryptVaultValue(encrypted, this.key));
        if (bundle.server !== server) {
          throw new CapletsError(
            "CONFIG_INVALID",
            "OAuth authority bundle server identity is invalid.",
          );
        }
        return bundle;
      })
      .sort((left, right) => left.server.localeCompare(right.server));
  }

  async write(bundle: StoredOAuthTokenBundle): Promise<void> {
    authStorePath(bundle.server);
    await this.ensureAuthorized({ operation: "write", server: bundle.server });
    const current = await this.readState();
    const encrypted = encryptVaultValue({
      plaintext: JSON.stringify(bundle),
      key: this.key,
      now: this.now(),
    });
    const snapshot = {
      ...current.snapshot,
      oauth: {
        version: 1 as const,
        keyFingerprint: this.keyFingerprint,
        bundles: { ...current.bundles, [bundle.server]: encrypted },
      },
    };
    await this.commitSnapshot(snapshot, "write", bundle.server, current.expectedGeneration);
  }

  async delete(server: string): Promise<boolean> {
    authStorePath(server);
    await this.ensureAuthorized({ operation: "delete", server });
    const current = await this.readState();
    if (!current.bundles[server]) return false;
    const { [server]: _deleted, ...bundles } = current.bundles;
    const snapshot = {
      ...current.snapshot,
      oauth: {
        version: 1 as const,
        keyFingerprint: this.keyFingerprint,
        bundles,
      },
    };
    await this.commitSnapshot(snapshot, "delete", server, current.expectedGeneration);
    return true;
  }

  async readTokenBundle(server: string): Promise<StoredOAuthTokenBundle | undefined> {
    return this.read(server);
  }

  async writeTokenBundle(bundle: StoredOAuthTokenBundle): Promise<void> {
    await this.write(bundle);
  }

  private async readState(): Promise<{
    snapshot: Record<string, unknown>;
    bundles: Record<string, VaultEncryptedRecord>;
    expectedGeneration: AuthorityGenerationIdentity | null;
  }> {
    const head = await this.authority.readHead();
    if (!head) {
      return { snapshot: { caplets: {} }, bundles: {}, expectedGeneration: null };
    }
    const generation = await this.authority.readGeneration(head.id);
    const snapshot = isRecord(generation.snapshot) ? structuredClone(generation.snapshot) : {};
    const nested = isRecord(snapshot.oauth)
      ? snapshot.oauth
      : isRecord(snapshot.oauthBundles)
        ? snapshot.oauthBundles
        : undefined;
    const fingerprint =
      typeof nested?.keyFingerprint === "string" ? nested.keyFingerprint : undefined;
    if (fingerprint && fingerprint !== this.keyFingerprint) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Shared OAuth encryption key does not match authority state.",
      );
    }
    const bundles: Record<string, VaultEncryptedRecord> = {};
    if (isRecord(nested?.bundles)) {
      for (const [server, record] of Object.entries(nested.bundles)) {
        authStorePath(server);
        bundles[server] = parseEncryptedRecord(record);
      }
    }
    return { snapshot, bundles, expectedGeneration: authorityGenerationIdentity(head) };
  }

  private async commitSnapshot(
    snapshot: Record<string, unknown>,
    operation: string,
    server: string,
    expectedGeneration: AuthorityGenerationIdentity | null,
  ): Promise<void> {
    const command = {
      kind: "replace_snapshot",
      snapshot: {
        ...snapshot,
        caplets: isRecord(snapshot.caplets) ? snapshot.caplets : {},
      },
    };
    const authorityCommand = command as never;
    const requestDigest = createHash("sha256")
      .update(stableJsonStringify({ operation, server, snapshot: command.snapshot }))
      .digest("hex");
    const result: AuthorityCommitResult = await this.authority.commit({
      authorityId: this.authorityId,
      currentHostId: this.currentHostId,
      principalId: this.principalId,
      expectedGeneration,
      idempotencyKey: randomUUID(),
      requestDigest,
      command: authorityCommand,
    });
    if (result.kind === "conflict") {
      throw new CapletsError(
        "REQUEST_INVALID",
        "OAuth authority generation changed; retry the request.",
      );
    }
    if (result.kind === "rate_limited" || result.kind === "quota_exhausted") {
      throw new CapletsError("SERVER_UNAVAILABLE", "OAuth authority mutation is rate limited.", {
        retryAfterMs: result.retryAfterMs,
      });
    }
  }

  private async ensureAuthorized(input: AuthorityOAuthAuthorization): Promise<void> {
    const result = await this.authorize?.(input);
    if (result === false) {
      throw new CapletsError("AUTH_FAILED", "OAuth authority authorization failed.");
    }
  }
}

function parseStoredBundle(value: string): StoredOAuthTokenBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CapletsError("CONFIG_INVALID", "OAuth authority bundle is not valid JSON.");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.server !== "string" ||
    typeof parsed.accessToken !== "string"
  ) {
    throw new CapletsError("CONFIG_INVALID", "OAuth authority bundle is malformed.");
  }
  return {
    server: parsed.server,
    accessToken: parsed.accessToken,
    ...(parsed.authType === "oauth2" || parsed.authType === "oidc"
      ? { authType: parsed.authType }
      : {}),
    ...(typeof parsed.refreshToken === "string" ? { refreshToken: parsed.refreshToken } : {}),
    ...(typeof parsed.tokenType === "string" ? { tokenType: parsed.tokenType } : {}),
    ...(typeof parsed.expiresAt === "string" ? { expiresAt: parsed.expiresAt } : {}),
    ...(typeof parsed.scope === "string" ? { scope: parsed.scope } : {}),
    ...(typeof parsed.idToken === "string" ? { idToken: parsed.idToken } : {}),
    ...(typeof parsed.issuer === "string" ? { issuer: parsed.issuer } : {}),
    ...(typeof parsed.subject === "string" ? { subject: parsed.subject } : {}),
    ...(typeof parsed.clientId === "string" ? { clientId: parsed.clientId } : {}),
    ...(typeof parsed.clientSecret === "string" ? { clientSecret: parsed.clientSecret } : {}),
    ...(typeof parsed.protectedResourceOrigin === "string"
      ? { protectedResourceOrigin: parsed.protectedResourceOrigin }
      : {}),
    ...(isRecord(parsed.metadata) ? { metadata: parsed.metadata } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function authorityGenerationIdentity(
  head: AuthorityHead | null,
): AuthorityGenerationIdentity | null {
  return head
    ? {
        authorityId: head.authorityId,
        id: head.id,
        sequence: head.sequence,
        predecessorId: head.predecessorId,
      }
    : null;
}
