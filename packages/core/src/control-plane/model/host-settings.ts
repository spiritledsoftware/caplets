export const HOST_SETTING_VERSION = 1 as const;

export type CanonicalHostSetting = {
  version: typeof HOST_SETTING_VERSION;
  key: "native.daemon-url";
  value: {
    source: "setup";
    url: string;
  };
  updatedAt: string;
};

export function parseCanonicalHostSetting(value: unknown): CanonicalHostSetting {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Host setting must be an object");
  const record = value as Record<string, unknown>;
  assertExactKeys(
    record,
    { version: true, key: true, value: true, updatedAt: true },
    "host setting",
  );
  if (record.version !== HOST_SETTING_VERSION) throw new Error("Unsupported host setting version");
  if (record.key !== "native.daemon-url") {
    if (
      typeof record.key === "string" &&
      /^(?:serve(?:\.|$)|storage(?:\.|$)|credentials?(?:\.|$)|keys?(?:\.|$)|backend(?:\.|$)|project(?:\.|$)|mcpServers$|openapiEndpoints$|googleDiscoveryApis$|graphqlEndpoints$|httpApis$|cliTools$|capletSets$)/u.test(
        record.key,
      )
    ) {
      throw new Error(
        `Deployment, credential, backend, and project setting ${record.key} cannot be SQL-owned`,
      );
    }
    throw new Error(`Unsupported SQL-owned host setting ${String(record.key)}`);
  }
  if (!record.value || typeof record.value !== "object" || Array.isArray(record.value))
    throw new Error("Host setting value is invalid");
  const settingValue = record.value as Record<string, unknown>;
  assertExactKeys(settingValue, { source: true, url: true }, "native daemon setting");
  if (settingValue.source !== "setup" || typeof settingValue.url !== "string")
    throw new Error("Native daemon setting is invalid");
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
  )
    throw new Error("Native daemon URL must use loopback HTTP");
  if (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt)))
    throw new Error("Host setting update clock is invalid");
  return {
    version: HOST_SETTING_VERSION,
    key: "native.daemon-url",
    value: { source: "setup", url: url.href },
    updatedAt: record.updatedAt,
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
