export type CatalogSearchRecord = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  trust: string;
  setup: string;
  count: number;
  searchText?: string | undefined;
};

export type CatalogSearchFilters = {
  query: string;
  trust: string;
  setup: string;
  tag: string;
  sort: "rank" | "name";
};

export function filterCatalogSearchRecords(
  records: CatalogSearchRecord[],
  filters: CatalogSearchFilters,
): CatalogSearchRecord[] {
  const query = filters.query.trim().toLowerCase();
  const normalizedQuery = normalizeSearchText(query);
  return records
    .filter((record) => {
      const searchable =
        record.searchText ?? [record.name, record.description, record.tags.join(" ")].join(" ");
      const lowerSearchable = searchable.toLowerCase();
      const normalizedSearchable = normalizeSearchText(lowerSearchable);
      return (
        (!query ||
          lowerSearchable.includes(query) ||
          normalizedSearchable.includes(normalizedQuery)) &&
        (filters.trust === "all" || record.trust === filters.trust) &&
        (filters.setup === "all" || record.setup === filters.setup) &&
        (filters.tag === "all" || record.tags.includes(filters.tag))
      );
    })
    .sort((left, right) => {
      if (filters.sort === "name") return left.name.localeCompare(right.name);
      const rank = right.count - left.count;
      return rank === 0 ? left.name.localeCompare(right.name) : rank;
    });
}

function normalizeSearchText(value: string): string {
  return value.replace(/[^a-z0-9]+/g, " ").trim();
}
