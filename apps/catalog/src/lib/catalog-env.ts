import type { D1Database } from "@cloudflare/workers-types";
// @ts-expect-error @astrojs/cloudflare provides this virtual module at runtime.
import { env } from "cloudflare:workers";

export type CatalogEnv = {
  CATALOG_DB?: D1Database;
  CAPLETS_CATALOG_SENTRY_DSN?: string;
  PUBLIC_CAPLETS_ENVIRONMENT?: string;
  PUBLIC_CAPLETS_RELEASE?: string;
};

export function getCatalogEnv(): CatalogEnv {
  return env as CatalogEnv;
}
