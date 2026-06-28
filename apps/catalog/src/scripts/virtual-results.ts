import {
  observeWindowOffset,
  observeWindowRect,
  Virtualizer,
  windowScroll,
  type VirtualItem,
} from "@tanstack/virtual-core";
import { filterCatalogSearchRecords, type CatalogSearchFilters } from "../lib/search-filter";
import type { CatalogSearchRow } from "../lib/search-row";
import {
  AlertCircleIcon,
  catalogStatusIcons,
  catalogTrustIcons,
  Copy01Icon,
  type IconSvgObject,
} from "../lib/status-icons";

const rowHeight = 72;
const compactRowHeight = 168;
const mobileRowHeight = 188;
const narrowRowHeight = 320;
const overscan = 8;

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
  const resultTable = root.querySelector("[data-result-table]") as HTMLElement | null;
  const resultStatus = root.querySelector("[data-result-status]") as HTMLElement | null;
  const emptyState = root.querySelector("[data-empty-state]") as HTMLElement | null;
  const reset = root.querySelector("[data-reset-search]") as HTMLButtonElement | null;
  const trust = root.querySelector('[data-filter="trust"]') as HTMLSelectElement | null;
  const setup = root.querySelector('[data-filter="setup"]') as HTMLSelectElement | null;
  const tag = root.querySelector('[data-filter="tag"]') as HTMLInputElement | null;
  const tagSelect = root.querySelector("#catalog-tag-select") as HTMLElement | null;
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
  const renderedRows = new Map<string, HTMLElement>();
  const virtualizer = new Virtualizer<Window, HTMLElement>({
    count: visibleRows.length,
    getScrollElement: () => window,
    estimateSize: estimateRowHeight,
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
      tag: tag?.value.trim() || "all",
      sort: sort?.value === "name" ? "name" : "rank",
    };
  }

  function applyUrlState(): void {
    const params = new URLSearchParams(window.location.search);
    inputEl.value = params.get("q") ?? "";
    if (trust) trust.value = params.get("scope") ?? "all";
    if (setup) setup.value = params.get("setup") ?? "all";
    setTagValue(params.get("tag") ?? "all");
    if (sort) sort.value = params.get("sort") === "name" ? "name" : "rank";
  }

  function writeUrlState(): void {
    const params = new URLSearchParams();
    if (inputEl.value.trim()) params.set("q", inputEl.value.trim());
    if (trust && trust.value !== "all") params.set("scope", trust.value);
    if (setup && setup.value !== "all") params.set("setup", setup.value);
    if (tag?.value.trim()) params.set("tag", tag.value.trim());
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
    resultTable?.setAttribute("aria-rowcount", String(visibleRows.length + 1));
    emptyStateEl.hidden = visibleRows.length > 0;
    resultSpacerEl.style.height = `${Math.max(virtualizer.getTotalSize(), visibleRows.length ? estimateRowHeight() : 1)}px`;
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
    resultSpacerEl.style.height = `${Math.max(virtualizer.getTotalSize(), visibleRows.length ? estimateRowHeight() : 1)}px`;
    const nextKeys = new Set<string>();
    let cursor: ChildNode | null = resultListEl.firstChild;

    for (const item of items) {
      const row = visibleRows[item.index];
      const key = virtualRowKey(item, row);
      nextKeys.add(key);

      let element = renderedRows.get(key);
      if (!element) {
        element = renderRow(item, row);
        renderedRows.set(key, element);
      } else {
        updateRowPosition(element, item, row);
      }

      if (element !== cursor) {
        resultListEl.insertBefore(element, cursor);
      }
      cursor = element.nextSibling;
    }

    for (const element of Array.from(
      resultListEl.querySelectorAll<HTMLElement>("[data-result-row]"),
    )) {
      const key = element.dataset.virtualKey;
      if (key && nextKeys.has(key)) continue;
      element.remove();
      if (key) renderedRows.delete(key);
    }
  }

  function navigateFromRowClick(event: MouseEvent): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const target = event.target as Element | null;
    if (!target || target.closest("[data-row-action]") || target.closest("a")) return;
    const row = target.closest<HTMLElement>("[data-result-row]");
    const href = row?.dataset.detailHref;
    if (href) window.location.href = href;
  }

  const events = new AbortController();
  for (const control of controls()) {
    control?.addEventListener("input", () => applySearch(), { signal: events.signal });
    control?.addEventListener("change", () => applySearch(), { signal: events.signal });
  }
  tagSelect?.addEventListener(
    "starwind-select:change",
    (event) => {
      const customEvent = event as CustomEvent<{ value?: string }>;
      setTagValue(customEvent.detail.value ?? "all", { syncSelect: false });
      applySearch();
    },
    { signal: events.signal },
  );

  reset?.addEventListener(
    "click",
    () => {
      inputEl.value = "";
      for (const select of [trust, setup]) {
        if (select) select.value = "all";
      }
      setTagValue("all");
      if (sort) sort.value = "rank";
      applySearch();
      inputEl.focus();
    },
    { signal: events.signal },
  );

  window.addEventListener(
    "popstate",
    () => {
      applyUrlState();
      applySearch({ writeUrl: false });
    },
    { signal: events.signal },
  );

  window.addEventListener(
    "resize",
    () => {
      virtualizer.measure();
      renderVirtualRows();
    },
    { signal: events.signal },
  );
  resultListEl.addEventListener("click", navigateFromRowClick, { signal: events.signal });

  applyUrlState();
  applySearch({ writeUrl: false, resetScroll: false });

  return {
    applySearch,
    destroy() {
      events.abort();
      cleanupVirtualizer();
    },
    renderedRowCount() {
      return resultListEl.querySelectorAll("[data-result-row]").length;
    },
  };
}

function setTagValue(value: string, options: { syncSelect?: boolean } = {}): void {
  const syncSelect = options.syncSelect ?? true;
  const normalizedValue = value.trim() || "all";
  const tagInput = document.querySelector('[data-filter="tag"]') as HTMLInputElement | null;
  const tagSelect = document.querySelector("#catalog-tag-select") as HTMLElement | null;
  if (tagInput) tagInput.value = normalizedValue === "all" ? "" : normalizedValue;
  if (!tagSelect || !syncSelect) return;

  document.dispatchEvent(
    new CustomEvent("starwind-select:select", {
      detail: { selectId: tagSelect.id, value: normalizedValue },
    }),
  );

  const triggerValue = tagSelect.querySelector('[data-slot="select-value"]');
  if (triggerValue)
    triggerValue.textContent = normalizedValue === "all" ? "Any tag" : normalizedValue;
}

function parseRows(value: string): CatalogSearchRow[] {
  const parsed = JSON.parse(value) as CatalogSearchRow[];
  return Array.isArray(parsed) ? parsed : [];
}

function estimateRowHeight(): number {
  if (window.matchMedia("(max-width: 420px)").matches) return narrowRowHeight;
  if (window.matchMedia("(max-width: 640px)").matches) return mobileRowHeight;
  if (window.matchMedia("(max-width: 900px)").matches) return compactRowHeight;
  return rowHeight;
}

function renderRow(item: VirtualItem, row: CatalogSearchRow | undefined): HTMLElement {
  const element = document.createElement("article");
  element.className = "catalog-result-row";
  element.role = "row";
  element.dataset.resultRow = "";
  updateRowPosition(element, item, row);
  if (!row) return element;
  element.innerHTML = `
    <div class="catalog-result-row__name" role="cell">
      ${renderCapletIcon(row)}
      <div class="catalog-result-row__heading">
        <a class="catalog-result-row__title" href="${escapeAttribute(row.detailHref)}">${escapeHtml(row.name)}</a>
      </div>
    </div>
    <p class="catalog-result-row__description" role="cell">${escapeHtml(row.description)}</p>
    <div class="catalog-result-row__installs" role="cell">${escapeHtml(row.installCountDisplay)}</div>
    <div class="catalog-result-row__statuses" role="cell" aria-label="Status">
      <span class="catalog-result-row__trust catalog-result-row__trust--${escapeAttribute(row.trust)}" title="${escapeAttribute(row.trust)}" aria-label="${escapeAttribute(row.trust)}">${renderIcon(catalogTrustIcons[row.trust] ?? AlertCircleIcon, row.trust, "catalog-result-row__trust-icon")}</span>
      ${row.statuses.map((status) => `<span class="catalog-result-row__status catalog-result-row__status--${escapeAttribute(status.severity)}" title="${escapeAttribute(status.label)}" aria-label="${escapeAttribute(status.label)}">${renderIcon(catalogStatusIcons[status.code] ?? AlertCircleIcon, status.label, "catalog-result-row__status-icon")}<span class="catalog-result-row__status-label">${escapeHtml(status.label)}</span></span>`).join("")}
    </div>
    <div class="catalog-result-row__actions" role="cell">
      ${
        row.installCommandCopyable
          ? `<button class="catalog-result-row__command catalog-result-row__command--copy" type="button" data-copy-command="${escapeAttribute(row.installCommandText)}" data-row-action aria-label="Copy install command for ${escapeAttribute(row.name)}" title="Copy install command"><code class="catalog-result-row__command-text">${escapeHtml(row.installCommandPreview)}</code>${renderIcon(Copy01Icon, "", "catalog-result-row__command-copy-icon")}</button>`
          : `<code class="catalog-result-row__command catalog-result-row__command--unavailable" title="${escapeAttribute(row.installCommandText)}">${escapeHtml(row.installCommandPreview)}</code>`
      }
    </div>
  `;
  return element;
}

function updateRowPosition(
  element: HTMLElement,
  item: VirtualItem,
  row: CatalogSearchRow | undefined,
): void {
  element.dataset.virtualKey = virtualRowKey(item, row);
  element.dataset.detailHref = row?.detailHref ?? "";
  element.dataset.index = String(item.index);
  element.setAttribute("aria-rowindex", String(item.index + 2));
  element.style.transform = `translateY(${item.start}px)`;
}

function virtualRowKey(item: VirtualItem, row: CatalogSearchRow | undefined): string {
  return row?.id ?? String(item.key);
}

function renderCapletIcon(row: CatalogSearchRow): string {
  if (!row.icon) {
    return `<span class="catalog-result-row__icon catalog-result-row__icon--fallback" aria-hidden="true">${escapeHtml(row.name.slice(0, 1).toUpperCase())}</span>`;
  }
  return `<img class="catalog-result-row__icon" src="${escapeAttribute(row.icon.url)}" alt="" width="32" height="32" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

function renderIcon(icon: IconSvgObject, label: string, className = ""): string {
  const classAttribute = className ? ` class="${escapeAttribute(className)}"` : "";
  const accessibilityAttributes = label
    ? ` aria-label="${escapeAttribute(label)}" role="img"`
    : ` aria-hidden="true"`;
  return `<svg${classAttribute}${accessibilityAttributes} fill="none" height="18" viewBox="0 0 24 24" width="18" xmlns="http://www.w3.org/2000/svg">${icon
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
