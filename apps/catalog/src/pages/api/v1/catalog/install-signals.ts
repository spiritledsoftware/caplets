import type { APIContext } from "astro";
import { getCatalogEnv } from "../../../../lib/catalog-env";
import { acceptInstallSignal, parseInstallSignalRequest } from "../../../../lib/ingest";
import { jsonResponse } from "../../../../lib/catalog-response";

export async function POST(context: APIContext): Promise<Response> {
  try {
    const signal = await parseInstallSignalRequest(context.request);
    const result = await acceptInstallSignal({
      signal,
      db: getCatalogEnv().CATALOG_DB,
    });
    if (result.status === "unavailable") {
      return jsonResponse(
        {
          ok: false,
          result,
          error: {
            code: "indexer_unavailable",
            message: "Catalog indexer is unavailable.",
          },
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    return jsonResponse(
      { ok: true, result },
      { status: result.status === "ineligible" ? 202 : 200 },
    );
  } catch {
    return jsonResponse(
      { ok: false, error: { code: "invalid_request", message: "Invalid catalog signal." } },
      { status: 400 },
    );
  }
}
