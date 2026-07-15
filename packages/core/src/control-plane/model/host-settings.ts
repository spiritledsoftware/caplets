export const HOST_SETTING_VERSION = 1 as const;

export type RuntimeMutableHostSetting =
  | Readonly<{ key: "telemetry"; value: boolean }>
  | Readonly<{
      key:
        | "options.defaultSearchLimit"
        | "options.maxSearchLimit"
        | "options.exposureDiscoveryTimeoutMs"
        | "options.exposureDiscoveryConcurrency"
        | "options.completion.discoveryTimeoutMs"
        | "options.completion.overallTimeoutMs"
        | "options.completion.cacheTtlMs"
        | "options.completion.negativeCacheTtlMs";
      value: number;
    }>
  | Readonly<{
      key: "options.exposure";
      value:
        | "direct"
        | "progressive"
        | "code_mode"
        | "direct_and_code_mode"
        | "progressive_and_code_mode";
    }>
  | Readonly<{
      key: "namespaceAliases";
      value: { local?: string | undefined; upstreams: Record<string, string> };
    }>;

export type CanonicalHostSetting = {
  version: typeof HOST_SETTING_VERSION;
  updatedAt: string;
} & (
  | RuntimeMutableHostSetting
  | Readonly<{
      key: "native.daemon-url";
      value: { source: "setup"; url: string };
    }>
);

export function parseCanonicalHostSetting(value: unknown): CanonicalHostSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Host setting must be an object");
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(
    record,
    { version: true, key: true, value: true, updatedAt: true },
    "host setting",
  );
  if (record.version !== HOST_SETTING_VERSION) throw new Error("Unsupported host setting version");
  if (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error("Host setting update clock is invalid");
  }
  if (record.key !== "native.daemon-url") {
    return {
      version: HOST_SETTING_VERSION,
      ...parseRuntimeMutableHostSetting(record.key, record.value),
      updatedAt: record.updatedAt,
    };
  }
  if (!record.value || typeof record.value !== "object" || Array.isArray(record.value)) {
    throw new Error("Host setting value is invalid");
  }
  const settingValue = record.value as Record<string, unknown>;
  assertExactKeys(settingValue, { source: true, url: true }, "native daemon setting");
  if (settingValue.source !== "setup" || typeof settingValue.url !== "string") {
    throw new Error("Native daemon setting is invalid");
  }
  let url: URL;
  try {
    url = new URL(settingValue.url);
  } catch {
    throw new Error("Native daemon URL is invalid");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]")
  ) {
    throw new Error("Native daemon URL must use loopback HTTP");
  }
  return {
    version: HOST_SETTING_VERSION,
    key: "native.daemon-url",
    value: { source: "setup", url: url.href },
    updatedAt: record.updatedAt,
  };
}

function parseRuntimeMutableHostSetting(key: unknown, value: unknown): RuntimeMutableHostSetting {
  if (key === "telemetry" && typeof value === "boolean") return { key, value };
  if (key === "options.exposure" && typeof value === "string") {
    const allowed: Record<string, true> = {
      direct: true,
      progressive: true,
      code_mode: true,
      direct_and_code_mode: true,
      progressive_and_code_mode: true,
    };
    if (allowed[value]) {
      return {
        key,
        value: value as Extract<RuntimeMutableHostSetting, { key: "options.exposure" }>["value"],
      };
    }
  }
  const numericBounds: Record<string, { minimum: number; maximum?: number | undefined }> = {
    "options.defaultSearchLimit": { minimum: 1 },
    "options.maxSearchLimit": { minimum: 1, maximum: 50 },
    "options.exposureDiscoveryTimeoutMs": { minimum: 1 },
    "options.exposureDiscoveryConcurrency": { minimum: 1, maximum: 32 },
    "options.completion.discoveryTimeoutMs": { minimum: 1 },
    "options.completion.overallTimeoutMs": { minimum: 1 },
    "options.completion.cacheTtlMs": { minimum: 0 },
    "options.completion.negativeCacheTtlMs": { minimum: 0 },
  };
  if (
    typeof key === "string" &&
    numericBounds[key] &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= numericBounds[key].minimum &&
    (numericBounds[key].maximum === undefined || value <= numericBounds[key].maximum)
  ) {
    return { key: key as Extract<RuntimeMutableHostSetting, { value: number }>["key"], value };
  }
  if (key === "namespaceAliases") {
    return { key, value: parseNamespaceAliases(value) };
  }
  if (
    typeof key === "string" &&
    /^(?:serve(?:\.|$)|storage(?:\.|$)|database(?:\.|$)|tls(?:\.|$)|credentials?(?:\.|$)|keys?(?:\.|$)|backend(?:\.|$)|catalog(?:\.|$)|tools?(?:\.|$)|project(?:\.|$)|mcpServers$|openapiEndpoints$|googleDiscoveryApis$|graphqlEndpoints$|httpApis$|cliTools$|capletSets$)/u.test(
      key,
    )
  ) {
    throw new Error(
      `Deployment, credential, backend, and project setting ${key} cannot be SQL-owned`,
    );
  }
  throw new Error(`Unsupported SQL-owned host setting ${String(key)}`);
}

function parseNamespaceAliases(value: unknown): {
  local?: string | undefined;
  upstreams: Record<string, string>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Namespace aliases setting must be an object");
  }
  const aliases = value as Record<string, unknown>;
  for (const key of Object.keys(aliases)) {
    if (key !== "local" && key !== "upstreams") {
      throw new Error(`Unsupported namespace aliases field ${key}`);
    }
  }
  const labelPattern = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
  if (
    aliases.local !== undefined &&
    (typeof aliases.local !== "string" || !labelPattern.test(aliases.local))
  ) {
    throw new Error("Namespace aliases local label is invalid");
  }
  if (
    !aliases.upstreams ||
    typeof aliases.upstreams !== "object" ||
    Array.isArray(aliases.upstreams)
  ) {
    throw new Error("Namespace aliases upstreams must be an object");
  }
  const usedAliases = new Set<string>();
  if (typeof aliases.local === "string") usedAliases.add(aliases.local);
  const upstreams: Record<string, string> = {};
  for (const [selector, alias] of Object.entries(aliases.upstreams as Record<string, unknown>)) {
    const normalizedSelector = selector.trim();
    if (
      !normalizedSelector ||
      normalizedSelector !== selector ||
      typeof alias !== "string" ||
      !labelPattern.test(alias) ||
      usedAliases.has(alias)
    ) {
      throw new Error("Namespace aliases upstream entry is invalid");
    }
    usedAliases.add(alias);
    upstreams[selector] = alias;
  }
  return {
    ...(typeof aliases.local === "string" ? { local: aliases.local } : {}),
    upstreams,
  };
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: Record<string, true>,
  label: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed[key]) throw new Error(`Unsupported ${label} field ${key}`);
  for (const key of Object.keys(allowed))
    if (!(key in value)) throw new Error(`Missing ${label} field ${key}`);
}
