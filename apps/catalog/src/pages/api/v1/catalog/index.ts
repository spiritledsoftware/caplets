import type { APIContext } from "astro";
import { getCatalogEnv } from "../../../../lib/catalog-env";
import { listCatalogEntries, listCompactCatalogEntries } from "../../../../lib/catalog-store";
import { jsonResponse } from "../../../../lib/catalog-response";

export async function GET(context: APIContext): Promise<Response> {
  const compact = context.url.searchParams.get("view") === "compact";
  const env = getCatalogEnv();
  return jsonResponse({
    version: 1,
    ...(compact ? { view: "compact" as const } : {}),
    entries: compact ? await listCompactCatalogEntries(env) : await listCatalogEntries(env),
  });
}
