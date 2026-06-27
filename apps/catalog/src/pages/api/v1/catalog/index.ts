import type { APIContext } from "astro";
import { getCatalogEnv } from "../../../../lib/catalog-env";
import { listCatalogEntries } from "../../../../lib/catalog-store";
import { jsonResponse } from "../../../../lib/catalog-response";

export async function GET(_context: APIContext): Promise<Response> {
  return jsonResponse({
    version: 1,
    entries: await listCatalogEntries(getCatalogEnv()),
  });
}
