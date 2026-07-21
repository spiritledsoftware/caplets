import type { APIContext } from "astro";
import { getCatalogEnv } from "../../../../lib/catalog-env";
import {
  listCatalogEntries,
  listCompactCatalogEntries,
  listCompactCatalogEntriesPage,
} from "../../../../lib/catalog-store";
import { jsonResponse } from "../../../../lib/catalog-response";

export async function GET(context: APIContext): Promise<Response> {
  const compact = context.url.searchParams.get("view") === "compact";
  const env = getCatalogEnv();
  if (compact && context.url.searchParams.has("limit")) {
    const page = parsePageOptions(context.url);
    if (!page) {
      return jsonResponse(
        { ok: false, error: { code: "invalid_request", message: "Invalid catalog page." } },
        { status: 400 },
      );
    }
    return jsonResponse({
      version: 1,
      view: "compact" as const,
      ...(await listCompactCatalogEntriesPage(page, env)),
    });
  }
  return jsonResponse({
    version: 1,
    ...(compact ? { view: "compact" as const } : {}),
    entries: compact ? await listCompactCatalogEntries(env) : await listCatalogEntries(env),
  });
}

function parsePageOptions(url: URL):
  | {
      limit: number;
      sort: "asc" | "desc";
      query?: string | undefined;
      after?: string | undefined;
    }
  | undefined {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? Number.NaN : Number(rawLimit);
  const sort = url.searchParams.get("sort") ?? "asc";
  const query = url.searchParams.get("q")?.trim();
  const after = url.searchParams.get("after")?.trim();
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    (sort !== "asc" && sort !== "desc") ||
    (query !== undefined && query.length > 1024) ||
    (after !== undefined && (after.length === 0 || after.length > 2048))
  ) {
    return undefined;
  }
  return {
    limit,
    sort,
    ...(query ? { query } : {}),
    ...(after ? { after } : {}),
  };
}
