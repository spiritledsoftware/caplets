import type { CatalogEnv } from "./catalog-env";

export async function captureCatalogServerError(error: unknown, env: CatalogEnv): Promise<void> {
  if (!env.CAPLETS_CATALOG_SENTRY_DSN) return;
  try {
    await fetch(sentryEnvelopeUrl(env.CAPLETS_CATALOG_SENTRY_DSN), {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: sentryEnvelopeBody(error, env),
    });
  } catch {
    // Server observability is best effort and must not affect indexing responses.
  }
}

function sentryEnvelopeUrl(dsn: string): string {
  const url = new URL(dsn);
  const projectId = url.pathname.split("/").filter(Boolean).at(-1);
  if (!projectId) throw new Error("invalid catalog worker Sentry DSN");
  return `${url.protocol}//${url.host}/api/${projectId}/envelope/`;
}

function sentryEnvelopeBody(error: unknown, env: CatalogEnv): string {
  const sentAt = new Date().toISOString();
  const eventId = crypto.randomUUID().replaceAll("-", "");
  const envelopeHeader = {
    event_id: eventId,
    dsn: env.CAPLETS_CATALOG_SENTRY_DSN,
    sent_at: sentAt,
  };
  const event = {
    event_id: eventId,
    timestamp: sentAt,
    platform: "javascript",
    level: "error",
    release: env.PUBLIC_CAPLETS_RELEASE,
    environment: env.PUBLIC_CAPLETS_ENVIRONMENT,
    tags: {
      surface: "catalog",
      route_family: "catalog",
      page_family: "catalog",
    },
    exception: exceptionFor(error),
  };
  return `${JSON.stringify(envelopeHeader)}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

function exceptionFor(error: unknown): { values: Array<{ type: string }> } {
  return {
    values: [
      {
        type:
          error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(error.name)
            ? error.name
            : "Error",
      },
    ],
  };
}
