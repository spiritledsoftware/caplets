import { sentryRollupPlugin, type SentryRollupPluginOptions } from "@sentry/rollup-plugin";
import type { RolldownPluginOption } from "rolldown";

export function sentryConfigured(): boolean {
  return Boolean(
    process.env.CAPLETS_SENTRY_AUTH_TOKEN &&
    process.env.CAPLETS_SENTRY_ORG &&
    process.env.CAPLETS_RUNTIME_SENTRY_PROJECT &&
    process.env.CAPLETS_SENTRY_RELEASE,
  );
}

export function runtimeSentryPlugins(
  dist: string,
  sourcemaps: SentryRollupPluginOptions["sourcemaps"] = {},
): RolldownPluginOption[] {
  const authToken = process.env.CAPLETS_SENTRY_AUTH_TOKEN;
  const org = process.env.CAPLETS_SENTRY_ORG;
  const project = process.env.CAPLETS_RUNTIME_SENTRY_PROJECT;
  const release = process.env.CAPLETS_SENTRY_RELEASE;
  if (!authToken || !org || !project || !release) return [];

  return sentryRollupPlugin({
    authToken,
    org,
    project,
    release: {
      name: release,
      dist,
    },
    sourcemaps,
  });
}
