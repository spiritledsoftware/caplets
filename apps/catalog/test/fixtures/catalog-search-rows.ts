import type { CatalogSearchRow } from "../../src/lib/search-row";

type CatalogSearchRowFixture = Partial<CatalogSearchRow> & Pick<CatalogSearchRow, "id" | "name">;

export function catalogSearchRowFixture(input: CatalogSearchRowFixture): CatalogSearchRow {
  const description = input.description ?? `${input.name} test description`;
  const tags = input.tags ?? [];
  const installCommandText =
    input.installCommandText ?? `caplets install spiritledsoftware/caplets ${input.id}`;
  const installCommandPreview = input.installCommandPreview ?? installCommandText;
  return {
    description,
    tags,
    trust: "official",
    setup: "ready",
    count: 0,
    installCountDisplay: "<10",
    sourceRepository: "spiritledsoftware/caplets",
    workflowLabel: "MCP server",
    authReadiness: "ready",
    projectBindingReadiness: "ready",
    detailHref: `/caplets/${encodeURIComponent(input.id)}/`,
    installCommandText,
    installCommandCopyable: true,
    statuses: [],
    searchText: [input.name, description, tags.join(" "), installCommandText]
      .join(" ")
      .toLowerCase(),
    ...input,
    installCommandPreview,
  };
}

export function manyCatalogSearchRows(count: number): CatalogSearchRow[] {
  return Array.from({ length: count }, (_, index) =>
    catalogSearchRowFixture({
      id: `caplet-${index}`,
      name: `Caplet ${index}`,
      description: `Compact row ${index} for virtual rendering checks.`,
      tags: index % 2 === 0 ? ["even", "mcp"] : ["odd", "cli"],
      count: count - index,
    }),
  );
}
