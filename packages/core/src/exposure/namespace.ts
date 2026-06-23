import { createHash } from "node:crypto";
import type { CapletShadowingPolicy } from "../config";
import { NAMESPACE_ALIAS_LABEL_PATTERN, SERVER_ID_PATTERN } from "../config/validation";

export type NamespaceSourceKind = "local" | "upstream";

export type NamespaceDiagnosticReason =
  | "namespace_collision"
  | "missing_durable_source_identity"
  | "namespace_alias_invalid"
  | "generated_id_collision"
  | "unsupported_protocol";

export type NamespaceSourceEntry<Route = unknown> = {
  baseId: string;
  sourceKind: NamespaceSourceKind;
  sourceLabel?: string | undefined;
  namespaceAlias?: string | undefined;
  durableSourceIdentity?: string | undefined;
  shadowing: CapletShadowingPolicy;
  route: Route;
};

export type NamespaceVisibleRecord<Route = unknown> = NamespaceSourceEntry<Route> & {
  id: string;
  label: string;
  namespaced: boolean;
};

export type NamespaceDiagnostic = {
  requestedId: string;
  reason: NamespaceDiagnosticReason;
  alternatives: string[];
  sources: Array<{
    sourceKind: NamespaceSourceKind;
    label: string;
    durableSourceIdentity?: string | undefined;
  }>;
  hint: string;
};

export type NamespaceResolution<Route = unknown> = {
  visibleRecords: NamespaceVisibleRecord<Route>[];
  routes: Map<string, Route>;
  suppressedBareIds: Map<string, NamespaceDiagnostic>;
  unavailableDiagnostics: NamespaceDiagnostic[];
};

export type NamespaceResolutionOptions = {
  hashLength?: number | undefined;
  maxHashLength?: number | undefined;
};

export function resolveNamespaceExposure<Route>(
  entries: NamespaceSourceEntry<Route>[],
  options: NamespaceResolutionOptions = {},
): NamespaceResolution<Route> {
  const hashLength = options.hashLength ?? 4;
  const maxHashLength = options.maxHashLength ?? 8;
  const groups = groupByBaseId(entries);
  const visibleRecords: NamespaceVisibleRecord<Route>[] = [];
  const suppressedBareIds = new Map<string, NamespaceDiagnostic>();
  const unavailableDiagnostics: NamespaceDiagnostic[] = [];
  const reservedBareIds = new Set(
    [...groups.entries()]
      .filter(([, group]) => group.length === 1 || !isNamespaceCollisionGroup(group))
      .map(([baseId]) => baseId),
  );

  for (const [baseId, group] of groups) {
    if (group.length === 1) {
      visibleRecords.push(visibleRecord(group[0]!, baseId, false));
      continue;
    }

    if (!isNamespaceCollisionGroup(group)) {
      visibleRecords.push(visibleRecord(nonNamespaceWinner(group), baseId, false));
      continue;
    }

    const diagnostics = validateNamespaceGroup(baseId, group);
    if (diagnostics.length > 0) {
      unavailableDiagnostics.push(...diagnostics);
      continue;
    }

    const resolved = qualifyNamespaceGroup(group, {
      baseId,
      hashLength,
      maxHashLength,
      reservedBareIds,
    });
    if ("diagnostic" in resolved) {
      unavailableDiagnostics.push(resolved.diagnostic);
      continue;
    }

    visibleRecords.push(...resolved.records);
    suppressedBareIds.set(
      baseId,
      diagnostic(
        baseId,
        "namespace_collision",
        group,
        resolved.records.map((record) => record.id),
      ),
    );
  }

  return {
    visibleRecords,
    routes: new Map(visibleRecords.map((record) => [record.id, record.route])),
    suppressedBareIds,
    unavailableDiagnostics,
  };
}

function groupByBaseId<Route>(
  entries: NamespaceSourceEntry<Route>[],
): Map<string, NamespaceSourceEntry<Route>[]> {
  const groups = new Map<string, NamespaceSourceEntry<Route>[]>();
  for (const entry of entries) {
    groups.set(entry.baseId, [...(groups.get(entry.baseId) ?? []), entry]);
  }
  return groups;
}

function isNamespaceCollisionGroup<Route>(group: NamespaceSourceEntry<Route>[]): boolean {
  const upstreams = group.filter((entry) => entry.sourceKind === "upstream");
  return upstreams.length > 0 && upstreams.every((entry) => entry.shadowing === "namespace");
}

function nonNamespaceWinner<Route>(
  group: NamespaceSourceEntry<Route>[],
): NamespaceSourceEntry<Route> {
  const forbiddingUpstream = group.find(
    (entry) => entry.sourceKind === "upstream" && entry.shadowing === "forbid",
  );
  if (forbiddingUpstream) return forbiddingUpstream;

  const local = group.find((entry) => entry.sourceKind === "local");
  if (local) return local;

  return group.find((entry) => entry.sourceKind === "upstream") ?? group[0]!;
}

function validateNamespaceGroup<Route>(
  baseId: string,
  group: NamespaceSourceEntry<Route>[],
): NamespaceDiagnostic[] {
  const diagnostics: NamespaceDiagnostic[] = [];
  for (const entry of group) {
    if (!entry.durableSourceIdentity) {
      diagnostics.push(diagnostic(baseId, "missing_durable_source_identity", group, []));
      break;
    }
    if (entry.namespaceAlias && !NAMESPACE_ALIAS_LABEL_PATTERN.test(entry.namespaceAlias)) {
      diagnostics.push(diagnostic(baseId, "namespace_alias_invalid", group, []));
      break;
    }
  }
  return diagnostics;
}

function qualifyNamespaceGroup<Route>(
  group: NamespaceSourceEntry<Route>[],
  options: {
    baseId: string;
    hashLength: number;
    maxHashLength: number;
    reservedBareIds: Set<string>;
  },
): { records: NamespaceVisibleRecord<Route>[] } | { diagnostic: NamespaceDiagnostic } {
  let hashLength = options.hashLength;
  while (hashLength <= options.maxHashLength) {
    const ids = group.map((entry) => qualifiedId(entry, options.baseId, hashLength));
    const idSet = new Set(ids);
    const collides =
      idSet.size !== ids.length ||
      ids.some((id) => options.reservedBareIds.has(id) || !SERVER_ID_PATTERN.test(id));

    if (!collides) {
      return {
        records: group.map((entry, index) => visibleRecord(entry, ids[index]!, true)),
      };
    }

    hashLength += 1;
  }

  return {
    diagnostic: diagnostic(options.baseId, "generated_id_collision", group, []),
  };
}

function qualifiedId<Route>(
  entry: NamespaceSourceEntry<Route>,
  baseId: string,
  hashLength: number,
): string {
  const label = namespaceLabel(entry);
  const hash = createHash("sha256")
    .update(entry.durableSourceIdentity ?? "")
    .digest("hex")
    .slice(0, hashLength);
  return `${label}-${hash}__${baseId}`;
}

function visibleRecord<Route>(
  entry: NamespaceSourceEntry<Route>,
  id: string,
  namespaced: boolean,
): NamespaceVisibleRecord<Route> {
  return {
    ...entry,
    id,
    label: namespaceLabel(entry),
    namespaced,
  };
}

function namespaceLabel<Route>(entry: NamespaceSourceEntry<Route>): string {
  return entry.namespaceAlias ?? entry.sourceLabel ?? entry.sourceKind;
}

function diagnostic<Route>(
  requestedId: string,
  reason: NamespaceDiagnosticReason,
  group: NamespaceSourceEntry<Route>[],
  alternatives: string[],
): NamespaceDiagnostic {
  return {
    requestedId,
    reason,
    alternatives,
    sources: group.map((entry) => ({
      sourceKind: entry.sourceKind,
      label: namespaceLabel(entry),
      ...(entry.durableSourceIdentity
        ? { durableSourceIdentity: entry.durableSourceIdentity }
        : {}),
    })),
    hint: diagnosticHint(requestedId, reason, alternatives),
  };
}

function diagnosticHint(
  requestedId: string,
  reason: NamespaceDiagnosticReason,
  alternatives: string[],
): string {
  if (reason === "namespace_collision") {
    return `Caplet '${requestedId}' is unavailable because namespace shadowing exposes qualified alternatives: ${alternatives.join(", ")}.`;
  }
  if (reason === "missing_durable_source_identity") {
    return `Caplet '${requestedId}' could not be namespaced because at least one source has no durable identity.`;
  }
  if (reason === "namespace_alias_invalid") {
    return `Caplet '${requestedId}' could not be namespaced because an alias label is invalid.`;
  }
  if (reason === "unsupported_protocol") {
    return `Caplet '${requestedId}' could not be namespaced because a source protocol cannot represent namespace metadata.`;
  }
  return `Caplet '${requestedId}' could not be namespaced because generated qualified IDs were not unique.`;
}
