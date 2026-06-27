import type { D1Database } from "@cloudflare/workers-types";
// @ts-expect-error @astrojs/cloudflare provides this virtual module at runtime.
import { env } from "cloudflare:workers";

export type CatalogEnv = {
  CATALOG_DB?: D1Database;
};

export function getCatalogEnv(): CatalogEnv {
  return env as CatalogEnv;
}
