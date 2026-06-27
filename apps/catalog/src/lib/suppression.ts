import type { D1Database } from "@cloudflare/workers-types";

export type SuppressionRecord = {
  entryKey: string;
  reason: string;
  suppressedAt: string;
};

export async function isSuppressed(db: D1Database | undefined, entryKey: string): Promise<boolean> {
  if (!db) return false;
  const record = await db
    .prepare("select entry_key from catalog_suppressions where entry_key = ? limit 1")
    .bind(entryKey)
    .first<{ entry_key: string }>();
  return Boolean(record);
}
