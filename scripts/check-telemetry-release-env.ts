const REQUIRED_TELEMETRY_RELEASE_ENV = [
  {
    name: "CAPLETS_POSTHOG_TOKEN",
    label: "PostHog project token",
    validate: isNonPlaceholderSecret,
  },
  {
    name: "CAPLETS_SENTRY_DSN",
    label: "Sentry DSN",
    validate: isSentryDsn,
  },
] as const;

export type TelemetryReleaseEnv = Record<string, string | undefined>;

export function checkTelemetryReleaseEnv(env: TelemetryReleaseEnv): string[] {
  const failures: string[] = [];

  for (const required of REQUIRED_TELEMETRY_RELEASE_ENV) {
    const value = env[required.name];
    if (value === undefined || value.trim() === "") {
      failures.push(`${required.name} is required for telemetry-enabled releases.`);
      continue;
    }
    if (!required.validate(value)) {
      failures.push(
        `${required.name} must be a valid ${required.label}; placeholders are not allowed.`,
      );
    }
  }

  return failures;
}

function isNonPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return false;
  return ![
    "todo",
    "todo before release",
    "changeme",
    "change-me",
    "placeholder",
    "example",
  ].includes(normalized);
}

function isSentryDsn(value: string): boolean {
  if (!isNonPlaceholderSecret(value)) return false;

  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
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
  const failures = checkTelemetryReleaseEnv(process.env);
  if (failures.length > 0) {
    console.error("Telemetry release environment is not configured:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    console.error(
      "Configure GitHub Actions secrets CAPLETS_POSTHOG_TOKEN and CAPLETS_SENTRY_DSN before publishing.",
    );
    process.exit(1);
  }

  console.log("Telemetry release environment is configured.");
}
