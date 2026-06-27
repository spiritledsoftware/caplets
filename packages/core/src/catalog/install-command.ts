import type { CatalogInstallCommand, CatalogSourceIdentity } from "./types";

export function generateCatalogInstallCommand(input: {
  source: CatalogSourceIdentity;
  capletId: string;
  resolvedRevision?: string | undefined;
  requireRevisionBound?: boolean | undefined;
}): CatalogInstallCommand {
  if (input.source.provider !== "github") {
    return {
      text: "",
      copyable: false,
      revisionBound: false,
      reason: "unsupported_source",
    };
  }

  const base = `caplets install ${input.source.repository} ${shellWord(input.capletId)}`;
  if (input.resolvedRevision) {
    return {
      text: base,
      copyable: false,
      revisionBound: false,
      reason: "revision_install_unsupported",
    };
  }

  return {
    text: base,
    copyable: !input.requireRevisionBound,
    revisionBound: false,
    ...(input.requireRevisionBound ? { reason: "revision_unavailable" as const } : {}),
  };
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9._/-]+$/u.test(value) ? value : JSON.stringify(value);
}
