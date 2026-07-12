import { CapletsError } from "../errors";
import type { AuthorityBootstrap, ResolvedAuthoritySecrets } from "../config";
import type { AuthorityProviderKind, WritableAuthority } from "./types";

export type AuthorityProviderContext = {
  bootstrap: AuthorityBootstrap;
  secrets: ResolvedAuthoritySecrets;
};

export type AuthorityProviderFactory = (
  context: AuthorityProviderContext,
) => Promise<WritableAuthority>;

const providers = new Map<AuthorityProviderKind, AuthorityProviderFactory>();

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
  const factory = providers.get(context.bootstrap.provider);
  if (!factory) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Authority provider ${context.bootstrap.provider} is not registered`,
    );
  }
  return factory(context);
}
