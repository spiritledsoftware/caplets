import {
  AlertCircleIcon,
  ComputerUserIcon,
  Copy01Icon,
  DatabaseSyncIcon,
  Key01Icon,
  Link01Icon,
  Settings02Icon,
  Shield01Icon,
} from "@hugeicons/core-free-icons";
import {
  observeWindowOffset,
  observeWindowRect,
  Virtualizer,
  windowScroll,
  type VirtualItem,
} from "@tanstack/virtual-core";
import { filterCatalogSearchRecords, type CatalogSearchFilters } from "../lib/search-filter";
import type { CatalogSearchRow, CatalogSearchStatusCode } from "../lib/search-row";

type IconNode = readonly [string, Readonly<Record<string, string | number>>];
type IconSvgObject = readonly IconNode[];

const rowHeight = 72;
const mobileRowHeight = 148;
const overscan = 8;
const statusIcons: Record<CatalogSearchStatusCode, IconSvgObject> = {
  unverified_community: Shield01Icon,
  local_control: ComputerUserIcon,
  mutating_saas: DatabaseSyncIcon,
  auth_required: Key01Icon,
  setup_required: Settings02Icon,
  project_binding_required: Link01Icon,
  readiness_unknown: AlertCircleIcon,
  vault_required: Key01Icon,
};

export type VirtualCatalogSearch = {
  applySearch(): void;
  destroy(): void;
  renderedRowCount(): number;
};

export function initVirtualCatalogSearch(
  root: Document | HTMLElement = document,
): VirtualCatalogSearch | undefined {
  const shell = root.querySelector("[data-search-shell]") as HTMLElement | null;
  const input = root.querySelector("[data-search-input]") as HTMLInputElement | null;
  const resultList = root.querySelector("[data-result-list]") as HTMLElement | null;
  const resultSpacer = root.querySelector("[data-result-spacer]") as HTMLElement | null;
  const resultStatus = root.querySelector("[data-result-status]") as HTMLElement | null;
  const emptyState = root.querySelector("[data-empty-state]") as HTMLElement | null;
  const reset = root.querySelector("[data-reset-search]") as HTMLButtonElement | null;
  const trust = root.querySelector('[data-filter="trust"]') as HTMLSelectElement | null;
  const setup = root.querySelector('[data-filter="setup"]') as HTMLSelectElement | null;
  const tag = root.querySelector('[data-filter="tag"]') as HTMLSelectElement | null;
  const sort = root.querySelector("[data-sort]") as HTMLSelectElement | null;
  const index = root.querySelector("[data-search-index]") as HTMLScriptElement | null;
  if (!shell || !input || !resultList || !resultSpacer || !resultStatus || !emptyState || !index) {
    return undefined;
  }

  const inputEl = input;
  const resultListEl = resultList;
  const resultSpacerEl = resultSpacer;
  const resultStatusEl = resultStatus;
  const emptyStateEl = emptyState;
  const rows = parseRows(index.textContent ?? "[]");
  let visibleRows = [...rows];
  let lastFocusedControl: HTMLElement | null = null;
  const virtualizer = new Virtualizer<Window, HTMLElement>({
    count: visibleRows.length,
    getScrollElement: () => window,
    estimateSize: () =>
      window.matchMedia("(max-width: 680px)").matches ? mobileRowHeight : rowHeight,
    overscan,
    scrollToFn: windowScroll,
    observeElementRect: observeWindowRect,
    observeElementOffset: observeWindowOffset,
    getItemKey: (index) => visibleRows[index]?.id ?? index,
    onChange: () => renderVirtualRows(),
  });
  const cleanupVirtualizer = virtualizer._didMount();
  virtualizer._willUpdate();

  function controls(): Array<HTMLInputElement | HTMLSelectElement | null> {
    return [inputEl, trust, setup, tag, sort];
  }

  function filters(): CatalogSearchFilters {
    return {
      query: inputEl.value,
      trust: trust?.value ?? "all",
      setup: setup?.value ?? "all",
      tag: tag?.value ?? "all",
      sort: sort?.value === "name" ? "name" : "rank",
    };
  }

  function applyUrlState(): void {
    const params = new URLSearchParams(window.location.search);
    inputEl.value = params.get("q") ?? "";
    if (trust && params.has("scope")) trust.value = params.get("scope") ?? "all";
    if (setup && params.has("setup")) setup.value = params.get("setup") ?? "all";
    if (tag && params.has("tag")) tag.value = params.get("tag") ?? "all";
    if (sort && params.has("sort")) sort.value = params.get("sort") === "name" ? "name" : "rank";
  }

  function writeUrlState(): void {
    const params = new URLSearchParams();
    if (inputEl.value.trim()) params.set("q", inputEl.value.trim());
    if (trust && trust.value !== "all") params.set("scope", trust.value);
    if (setup && setup.value !== "all") params.set("setup", setup.value);
    if (tag && tag.value !== "all") params.set("tag", tag.value);
    if (sort && sort.value !== "rank") params.set("sort", sort.value);
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", next);
  }

  function applySearch(options: { writeUrl?: boolean; resetScroll?: boolean } = {}): void {
    lastFocusedControl =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    visibleRows = filterCatalogSearchRecords(rows, filters()) as CatalogSearchRow[];
    virtualizer.setOptions({ ...virtualizer.options, count: visibleRows.length });
    resultStatusEl.textContent = `${visibleRows.length} ${visibleRows.length === 1 ? "Caplet" : "Caplets"}`;
    emptyStateEl.hidden = visibleRows.length > 0;
    resultSpacerEl.style.height = `${Math.max(virtualizer.getTotalSize(), visibleRows.length ? rowHeight : 1)}px`;
    if (options.writeUrl !== false) writeUrlState();
    if (options.resetScroll !== false) virtualizer.scrollToIndex(0, { align: "start" });
    renderVirtualRows();
    if (
      lastFocusedControl &&
      controls().includes(lastFocusedControl as HTMLInputElement | HTMLSelectElement)
    ) {
      lastFocusedControl.focus();
    }
  }

  function renderVirtualRows(): void {
    const items = virtualizer.getVirtualItems();
    resultSpacerEl.style.height = `${Math.max(virtualizer.getTotalSize(), visibleRows.length ? rowHeight : 1)}px`;
    resultListEl.replaceChildren(...items.map((item) => renderRow(item, visibleRows[item.index])));
  }

  for (const control of controls()) {
    control?.addEventListener("input", () => applySearch());
    control?.addEventListener("change", () => applySearch());
  }

  reset?.addEventListener("click", () => {
    inputEl.value = "";
    for (const select of [trust, setup, tag]) {
      if (select) select.value = "all";
    }
    if (sort) sort.value = "rank";
    applySearch();
    inputEl.focus();
  });

  window.addEventListener("popstate", () => {
    applyUrlState();
    applySearch({ writeUrl: false });
  });

  window.addEventListener("resize", () => {
    virtualizer.measure();
    renderVirtualRows();
  });

  applyUrlState();
  applySearch({ writeUrl: false, resetScroll: false });

  return {
    applySearch,
    destroy() {
      cleanupVirtualizer();
    },
    renderedRowCount() {
      return resultListEl.querySelectorAll("[data-result-row]").length;
    },
  };
}

function parseRows(value: string): CatalogSearchRow[] {
  const parsed = JSON.parse(value) as CatalogSearchRow[];
  return Array.isArray(parsed) ? parsed : [];
}

function renderRow(item: VirtualItem, row: CatalogSearchRow | undefined): HTMLElement {
  const element = document.createElement("article");
  element.className = "catalog-result-row";
  element.role = "row";
  element.dataset.resultRow = "";
  element.dataset.index = String(item.index);
  element.style.transform = `translateY(${item.start}px)`;
  if (!row) return element;
  element.innerHTML = `
    <div class="catalog-result-row__name" role="cell">
      <div class="catalog-result-row__heading">
        <a class="catalog-result-row__title" href="${escapeAttribute(row.detailHref)}">${escapeHtml(row.name)}</a>
        <span class="catalog-result-row__trust">${escapeHtml(row.trust)}</span>
      </div>
    </div>
    <p class="catalog-result-row__description" role="cell">${escapeHtml(row.description)}</p>
    <div class="catalog-result-row__installs" role="cell">${escapeHtml(row.installCountDisplay)}</div>
    <div class="catalog-result-row__command" role="cell">
      <code title="${escapeAttribute(row.installCommandText)}">${escapeHtml(row.installCommandText)}</code>
      ${row.installCommandCopyable ? `<button class="catalog-result-row__copy" type="button" aria-label="Copy install command for ${escapeAttribute(row.name)}" data-copy-command="${escapeAttribute(row.installCommandText)}">${renderIcon(Copy01Icon, "Copy")}</button>` : `<span class="catalog-result-row__copy-unavailable">Copy unavailable</span>`}
    </div>
    <div class="catalog-result-row__statuses" role="cell" aria-label="Status">
      ${row.statuses.map((status) => `<span class="catalog-result-row__status catalog-result-row__status--${escapeAttribute(status.severity)}" title="${escapeAttribute(status.label)}" aria-label="${escapeAttribute(status.label)}">${renderIcon(statusIcons[status.code] ?? AlertCircleIcon, status.label)}</span>`).join("")}
    </div>
  `;
  return element;
}

function renderIcon(icon: IconSvgObject, label: string): string {
  return `<svg aria-label="${escapeAttribute(label)}" role="img" fill="none" height="18" viewBox="0 0 24 24" width="18" xmlns="http://www.w3.org/2000/svg">${icon
    .map(
      ([, attrs]) =>
        `<path ${Object.entries(attrs)
          .filter(([key]) => key !== "key")
          .map(([key, value]) => `${dashAttr(key)}="${escapeAttribute(String(value))}"`)
          .join(" ")} />`,
    )
    .join("")}</svg>`;
}

function dashAttr(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
