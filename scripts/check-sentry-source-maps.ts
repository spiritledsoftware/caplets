const REQUIRED_SOURCE_MAP_ENV = [
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
  "CAPLETS_LANDING_SENTRY_PROJECT",
  "CAPLETS_DOCS_SENTRY_PROJECT",
  "CAPLETS_CATALOG_SENTRY_PROJECT",
  "PUBLIC_CAPLETS_RELEASE",
  "PUBLIC_CAPLETS_ENVIRONMENT",
] as const;

export type SentrySourceMapEnv = Record<string, string | undefined>;

export function checkSentrySourceMapEnv(env: SentrySourceMapEnv): string[] {
  return REQUIRED_SOURCE_MAP_ENV.flatMap((name) => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      return [`${name} is required before uploading Sentry source maps.`];
    }
    if (["todo", "changeme", "placeholder", "example"].includes(value.trim().toLowerCase())) {
      return [`${name} cannot be a placeholder before uploading Sentry source maps.`];
    }
    return [];
  });
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const failures = checkSentrySourceMapEnv(process.env);
  if (failures.length > 0) {
    console.error("Sentry source-map environment is not configured:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("Sentry source-map environment is configured.");
}
