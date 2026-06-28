import type { CatalogWarning, CatalogWarningSeverity } from "@caplets/core/catalog";
import type { CatalogEntryRecord } from "./catalog-store";

export type CatalogSearchStatusCode = CatalogWarning["code"] | "vault_required";

export type CatalogSearchStatus = {
  code: CatalogSearchStatusCode;
  label: string;
  severity: CatalogWarningSeverity;
};

export type CatalogSearchRow = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  trust: string;
  setup: string;
  count: number;
  installCountDisplay: string;
  sourceRepository: string;
  workflowLabel: string;
  authReadiness: string;
  projectBindingReadiness: string;
  detailHref: string;
  installCommandText: string;
  installCommandPreview: string;
  installCommandCopyable: boolean;
  statuses: CatalogSearchStatus[];
  searchText: string;
};

export function catalogSearchRowFromEntry(entry: CatalogEntryRecord): CatalogSearchRow {
  const statuses = entry.warnings.map((warning) => ({
    code: warning.code,
    label: warning.label,
    severity: warning.severity,
  }));
  const installCommandText = entry.installCommand.text || "Install command unavailable";
  const installCommandPreview = previewInstallCommand(installCommandText);
  const row: Omit<CatalogSearchRow, "searchText"> = {
    id: entry.entryKey,
    name: entry.name,
    description: entry.description,
    tags: entry.tags,
    trust: entry.trustLevel,
    setup: entry.setupReadiness,
    count: entry.rankScore,
    installCountDisplay: entry.installCountDisplay,
    sourceRepository: entry.source.repository,
    workflowLabel: entry.workflow.label,
    authReadiness: entry.authReadiness,
    projectBindingReadiness: entry.projectBindingReadiness,
    detailHref: `/caplets/${encodeURIComponent(entry.entryKey)}/`,
    installCommandText,
    installCommandPreview,
    installCommandCopyable: entry.installCommand.copyable,
    statuses,
  };
  return {
    ...row,
    searchText: [
      row.name,
      row.description,
      row.tags.join(" "),
      row.sourceRepository,
      row.workflowLabel,
      row.installCommandText,
    ]
      .join(" ")
      .toLowerCase(),
  };
}

export function catalogSearchRowsFromEntries(entries: CatalogEntryRecord[]): CatalogSearchRow[] {
  return entries.map(catalogSearchRowFromEntry);
}

function previewInstallCommand(command: string): string {
  const normalized = command.trim();
  return normalized || "Install command unavailable";
}
