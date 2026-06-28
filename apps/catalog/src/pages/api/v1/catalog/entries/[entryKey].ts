import type { APIContext } from "astro";
import { getCatalogEnv } from "../../../../../lib/catalog-env";
import { getCatalogEntry } from "../../../../../lib/catalog-store";
import { jsonResponse, notFound } from "../../../../../lib/catalog-response";
import { decodeEntryRouteKey } from "../../../../../lib/entry-route";

export async function GET(context: APIContext): Promise<Response> {
  const entryKey = context.params.entryKey
    ? decodeEntryRouteKey(context.params.entryKey)
    : undefined;
  if (!entryKey) {
    return notFound();
  }

  const entry = await getCatalogEntry(entryKey, getCatalogEnv());
  return entry ? jsonResponse({ version: 1, entry }) : notFound();
}
