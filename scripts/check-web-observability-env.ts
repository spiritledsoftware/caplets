const REQUIRED_WEB_OBSERVABILITY_ENV = [
  ["PUBLIC_CAPLETS_POSTHOG_TOKEN", "public PostHog project token"],
  ["PUBLIC_CAPLETS_POSTHOG_HOST", "public PostHog host"],
  ["PUBLIC_CAPLETS_LANDING_SENTRY_DSN", "landing Sentry DSN"],
  ["PUBLIC_CAPLETS_DOCS_SENTRY_DSN", "docs Sentry DSN"],
  ["PUBLIC_CAPLETS_CATALOG_SENTRY_DSN", "catalog Sentry DSN"],
  ["SENTRY_AUTH_TOKEN", "Sentry source-map auth token"],
  ["SENTRY_ORG", "Sentry org slug"],
  ["CAPLETS_LANDING_SENTRY_PROJECT", "landing Sentry project slug"],
  ["CAPLETS_DOCS_SENTRY_PROJECT", "docs Sentry project slug"],
  ["CAPLETS_CATALOG_SENTRY_PROJECT", "catalog Sentry project slug"],
  ["PUBLIC_CAPLETS_RELEASE", "public site release name"],
  ["PUBLIC_CAPLETS_ENVIRONMENT", "public site environment"],
] as const;

export type WebObservabilityEnv = Record<string, string | undefined>;

export function checkWebObservabilityEnv(env: WebObservabilityEnv): string[] {
  const failures: string[] = [];
  for (const [name, label] of REQUIRED_WEB_OBSERVABILITY_ENV) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      failures.push(`${name} is required for observability-enabled site deploys.`);
      continue;
    }
    if (!isValidValue(name, value)) {
      failures.push(`${name} must be a valid ${label}; placeholders are not allowed.`);
    }
  }
  return failures;
}

function isValidValue(name: string, value: string): boolean {
  if (!isNonPlaceholder(value)) return false;
  if (name.endsWith("_SENTRY_DSN")) return isSentryDsn(value);
  if (name.endsWith("_HOST")) return isHttpUrl(value);
  if (name.includes("PROJECT") || name === "SENTRY_ORG" || name.endsWith("_ENVIRONMENT")) {
    return /^[a-zA-Z0-9._-]{1,80}$/u.test(value.trim());
  }
  return true;
}

function isNonPlaceholder(value: string): boolean {
  return ![
    "",
    "todo",
    "todo before release",
    "changeme",
    "change-me",
    "placeholder",
    "example",
  ].includes(value.trim().toLowerCase());
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function isSentryDsn(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username.length > 0 &&
      url.hostname.length > 0 &&
      url.pathname !== "" &&
      url.pathname !== "/"
    );
  } catch {
    return false;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const failures = checkWebObservabilityEnv(process.env);
  if (failures.length > 0) {
    console.error("Web observability environment is not configured:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("Web observability environment is configured.");
}
