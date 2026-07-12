import { dirname, resolve } from "node:path";
import { CapletsError } from "../errors";
import type { NormalizedStorageBootstrap, ResolvedStorageSecrets } from "../config";
import type { AuthorityProviderKind, WritableAuthority } from "./types";

export type AuthorityProviderContext = {
  bootstrap: NormalizedStorageBootstrap;
  secrets: ResolvedStorageSecrets;
};

export type AuthorityProviderFactory = (
  context: AuthorityProviderContext,
) => Promise<WritableAuthority>;

const providers = new Map<AuthorityProviderKind, AuthorityProviderFactory>();

export type AuthorityProviderLookupResult =
  | { kind: "registered"; factory: AuthorityProviderFactory }
  | { kind: "registry-miss"; provider: AuthorityProviderKind };

export class AuthorityProviderRegistryMissError extends CapletsError {
  readonly kind = "registry-miss" as const;
  readonly provider: AuthorityProviderKind;

  constructor(provider: AuthorityProviderKind) {
    super("CONFIG_INVALID", `Authority provider ${provider} is not registered`, { provider });
    this.name = "AuthorityProviderRegistryMissError";
    this.provider = provider;
  }
}

export function lookupAuthorityProvider(
  kind: AuthorityProviderKind,
): AuthorityProviderLookupResult {
  const factory = providers.get(kind);
  return factory ? { kind: "registered", factory } : { kind: "registry-miss", provider: kind };
}

export function assertAuthorityLifecycleIdentity(authority: WritableAuthority): WritableAuthority {
  if (
    authority === null ||
    typeof authority !== "object" ||
    typeof authority.namespace !== "string" ||
    authority.namespace.length === 0 ||
    typeof authority.schemaVersion !== "number" ||
    !Number.isSafeInteger(authority.schemaVersion) ||
    authority.schemaVersion < 1
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Authority provider must expose a valid namespace and schema version",
    );
  }
  return authority;
}

export function registerAuthorityProvider(
  kind: AuthorityProviderKind,
  factory: AuthorityProviderFactory,
): () => void {
  if (providers.has(kind)) {
    throw new CapletsError("CONFIG_INVALID", `Authority provider ${kind} is already registered`);
  }
  providers.set(kind, factory);
  return () => {
    if (providers.get(kind) === factory) providers.delete(kind);
  };
}

export function registeredAuthorityProviders(): AuthorityProviderKind[] {
  return [...providers.keys()].sort();
}

export async function createAuthority(
  context: AuthorityProviderContext,
): Promise<WritableAuthority> {
  const lookup = lookupAuthorityProvider(context.bootstrap.provider);
  if (lookup.kind === "registry-miss") {
    throw new AuthorityProviderRegistryMissError(lookup.provider);
  }
  return assertAuthorityLifecycleIdentity(await lookup.factory(context));
}
export async function createAuthorityWithBuiltinFallback(
  context: AuthorityProviderContext,
  configPath: string,
): Promise<WritableAuthority> {
  const lookup = lookupAuthorityProvider(context.bootstrap.provider);
  if (lookup.kind === "registry-miss") {
    return await createBuiltinAuthority(context, configPath);
  }
  return assertAuthorityLifecycleIdentity(await lookup.factory(context));
}

export async function createBuiltinAuthority(
  context: AuthorityProviderContext,
  configPath: string,
): Promise<WritableAuthority> {
  const { bootstrap, secrets } = context;
  if (bootstrap.provider === "filesystem") {
    // Provider modules are selected at runtime from the configured provider.
    const { createFilesystemAuthority } = await import("./filesystem-authority");
    return assertAuthorityLifecycleIdentity(
      await createFilesystemAuthority({
        root: bootstrap.path ?? resolve(dirname(configPath), "caplets"),
        authorityId: bootstrap.authorityId,
        namespace: bootstrap.namespace,
      }),
    );
  }
  if (bootstrap.provider === "sqlite") {
    // Provider modules are selected at runtime from the configured provider.
    const { createSqliteAuthority } = await import("./sql/authority");
    return assertAuthorityLifecycleIdentity(
      await createSqliteAuthority({
        databasePath: bootstrap.databasePath,
        authorityId: bootstrap.authorityId,
        namespace: bootstrap.namespace,
      }),
    );
  }
  if (bootstrap.provider === "postgresql") {
    if (typeof secrets.credential !== "string") {
      throw new CapletsError("CONFIG_INVALID", "PostgreSQL storage requires a resolved connection");
    }
    // Provider modules are selected at runtime from the configured provider.
    const { createPostgresAuthority } = await import("./sql/authority");
    return assertAuthorityLifecycleIdentity(
      await createPostgresAuthority({
        connectionString: secrets.credential,
        authorityId: bootstrap.authorityId,
        namespace: bootstrap.namespace,
      }),
    );
  }
  const credential = secrets.credential;
  // Provider modules are selected at runtime from the configured provider.
  const { createS3Authority } = await import("./s3-authority");
  return assertAuthorityLifecycleIdentity(
    await createS3Authority({
      bucket: bootstrap.bucket,
      region: bootstrap.region,
      ...(bootstrap.path === undefined ? {} : { path: bootstrap.path }),
      ...(bootstrap.endpoint === undefined ? {} : { endpoint: bootstrap.endpoint }),
      ...(bootstrap.forcePathStyle === undefined
        ? {}
        : { forcePathStyle: bootstrap.forcePathStyle }),
      ...(credential === undefined
        ? {}
        : { credentialProvider: () => parseS3Credential(credential) }),
      authorityId: bootstrap.authorityId,
      namespace: bootstrap.namespace,
    }),
  );
}

function parseS3Credential(value: string | Uint8Array): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} {
  if (typeof value !== "string")
    throw new CapletsError("CONFIG_INVALID", "S3 credential is invalid");
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.accessKeyId !== "string" || typeof parsed.secretAccessKey !== "string")
      throw new Error("invalid");
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      ...(typeof parsed.sessionToken === "string" ? { sessionToken: parsed.sessionToken } : {}),
    };
  } catch {
    throw new CapletsError(
      "CONFIG_INVALID",
      "S3 credential must resolve to a JSON access key pair",
    );
  }
}
