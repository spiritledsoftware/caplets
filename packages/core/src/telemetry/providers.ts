import type { NodeClient, NodeOptions } from "@sentry/node";
import type { PostHog } from "posthog-node";
import type { ProductTelemetryEvent, ReliabilityTelemetryEvent, TelemetryEvent } from "./events";
import { stripSentryEvent } from "./privacy";
import { recordTelemetryDrop, type TelemetryState } from "./state";

export type PostHogClient = Pick<PostHog, "capture" | "shutdown">;
export type SentryClient = Pick<NodeClient, "captureEvent" | "flush">;

export type TelemetryProviderFactories = {
  createPostHog?: ((token: string) => Promise<PostHogClient> | PostHogClient) | undefined;
  createSentry?: ((dsn: string) => Promise<SentryClient> | SentryClient) | undefined;
};

export type TelemetryDispatcherOptions = {
  posthogToken?: string | undefined;
  sentryDsn?: string | undefined;
  stateDir?: string | undefined;
  factories?: TelemetryProviderFactories | undefined;
};

export type TelemetryDispatcher = {
  capture(state: TelemetryState, event: TelemetryEvent): Promise<void>;
  shutdown(): Promise<void>;
};

export function createTelemetryDispatcher(
  options: TelemetryDispatcherOptions = {},
): TelemetryDispatcher {
  let posthog: Promise<PostHogClient> | undefined;
  let sentry: Promise<SentryClient> | undefined;

  async function posthogClient(): Promise<PostHogClient | undefined> {
    const token = options.posthogToken ?? process.env.CAPLETS_POSTHOG_TOKEN;
    if (!token) return undefined;
    posthog ??= Promise.resolve((options.factories?.createPostHog ?? defaultPostHogFactory)(token));
    return posthog;
  }

  async function sentryClient(): Promise<SentryClient | undefined> {
    const dsn = options.sentryDsn ?? process.env.CAPLETS_SENTRY_DSN;
    if (!dsn) return undefined;
    sentry ??= Promise.resolve((options.factories?.createSentry ?? defaultSentryFactory)(dsn));
    return sentry;
  }

  return {
    async capture(state, event) {
      if (state.status !== "enabled") {
        return;
      }
      try {
        if (event.provider === "posthog") {
          await capturePostHog(await posthogClient(), event, state.stateDir ?? options.stateDir);
          return;
        }
        await captureSentry(await sentryClient(), event, state.stateDir ?? options.stateDir);
      } catch {
        recordTelemetryDrop({
          stateDir: state.stateDir ?? options.stateDir,
          provider: event.provider,
          reason: "send_failed",
        });
      }
    },
    async shutdown() {
      const clients = await Promise.allSettled([posthog, sentry]);
      for (const client of clients) {
        if (client.status !== "fulfilled" || !client.value) continue;
        if ("shutdown" in client.value) {
          await Promise.resolve(client.value.shutdown()).catch(() => undefined);
        }
        if ("flush" in client.value) {
          await Promise.resolve(client.value.flush(2_000)).catch(() => undefined);
        }
      }
    },
  };
}

async function capturePostHog(
  client: PostHogClient | undefined,
  event: ProductTelemetryEvent,
  stateDir: string | undefined,
): Promise<void> {
  if (!client) {
    recordTelemetryDrop({ stateDir, provider: "posthog", reason: "not_configured" });
    return;
  }
  client.capture({
    distinctId: event.distinctId,
    event: event.name,
    properties: {
      $geoip_disable: true,
      ...event.properties,
    },
  });
}

async function captureSentry(
  client: SentryClient | undefined,
  event: ReliabilityTelemetryEvent,
  stateDir: string | undefined,
): Promise<void> {
  if (!client) {
    recordTelemetryDrop({ stateDir, provider: "sentry", reason: "not_configured" });
    return;
  }
  client.captureEvent({
    level: "error",
    tags: event.tags,
    fingerprint: event.fingerprint,
  });
}

async function defaultPostHogFactory(token: string): Promise<PostHogClient> {
  const { PostHog } = await import("posthog-node");
  return new PostHog(token, {
    flushAt: 20,
    flushInterval: 10_000,
    disableGeoip: true,
    historicalMigration: false,
  });
}

async function defaultSentryFactory(dsn: string): Promise<SentryClient> {
  const sentry = await import("@sentry/node");
  const options = {
    dsn,
    sendDefaultPii: false,
    defaultIntegrations: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      return stripSentryEvent(
        event as unknown as Record<string, unknown>,
      ) as unknown as typeof event;
    },
  } satisfies NodeOptions;
  sentry.init(options);
  return sentry.getClient() as NodeClient;
}
