import { CapletsError } from "../errors";

export const DEFAULT_STORAGE_PAGE_LIMIT = 100;
export const MAX_STORAGE_PAGE_LIMIT = 500;

export type KeysetSortDirection = "asc" | "desc";

export type StorageKeysetPage<Item, Key> = {
  items: Item[];
  nextKey?: Key | undefined;
};

export function storagePageLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_STORAGE_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_STORAGE_PAGE_LIMIT) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Page limit must be an integer between 1 and ${MAX_STORAGE_PAGE_LIMIT}.`,
    );
  }
  return limit;
}
