import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useWindowVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { CheckCircle2Icon, CopyIcon, DownloadIcon, ShieldCheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { catalogDetailHref } from "./catalog-route";
import type { CatalogCompactEntry } from "./catalog-state";

export const CATALOG_RESULTS_OVERSCAN = 8;

export function catalogRowEstimate(width: number): number {
  if (width < 640) return 320;
  if (width < 1024) return 188;
  return 112;
}

export type CatalogResultsProps = {
  visible: CatalogCompactEntry[];
  discoveryKey: string;
  installingKey?: string;
  onInstall(entry: CatalogCompactEntry): void;
  onCopy(command: string, entry: CatalogCompactEntry): Promise<void>;
  onNavigate?(event: ReactMouseEvent<HTMLElement>, entry: CatalogCompactEntry): void;
};

export function CatalogResults(props: CatalogResultsProps) {
  if (typeof window === "undefined") {
    return <div data-catalog-results aria-label="Catalog results" />;
  }
  return <CatalogResultsClient {...props} />;
}

function CatalogResultsClient({
  visible,
  installingKey,
  discoveryKey,
  onInstall,
  onCopy,
  onNavigate = (event) => {
    if (!event.defaultPrevented) return;
  },
}: CatalogResultsProps) {
  const spacerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const identity = useMemo(() => visible.map((entry) => entry.entryKey).join("\u0000"), [visible]);
  const virtualizer = useWindowVirtualizer({
    count: visible.length,
    estimateSize: () => catalogRowEstimate(window.innerWidth),
    getItemKey: (index) => visible[index]?.entryKey ?? index,
    overscan: CATALOG_RESULTS_OVERSCAN,
    scrollMargin,
    initialRect: { width: window.innerWidth, height: window.innerHeight },
  });

  useLayoutEffect(() => {
    const top = (spacerRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY;
    setScrollMargin((current) => (current === top ? current : top));
    virtualizer.measure();
  }, [identity, virtualizer]);

  useEffect(() => {
    const active = document.activeElement;
    virtualizer.scrollToIndex(0, { align: "start" });
    if (active instanceof HTMLElement && active.matches("input,select,textarea,button,a[href]"))
      active.focus();
  }, [discoveryKey, virtualizer]);

  useEffect(() => {
    const media = [640, 1024].map((width) => window.matchMedia(`(min-width: ${width}px)`));
    const remeasure = () => virtualizer.measure();
    window.addEventListener("resize", remeasure);
    media.forEach((query) => query.addEventListener("change", remeasure));
    return () => {
      window.removeEventListener("resize", remeasure);
      media.forEach((query) => query.removeEventListener("change", remeasure));
    };
  }, [virtualizer]);

  const items = virtualizer.getVirtualItems();
  const total = Math.max(
    virtualizer.getTotalSize(),
    visible.length ? catalogRowEstimate(window.innerWidth) : 1,
  );

  function rowClick(event: ReactMouseEvent<HTMLElement>, entry: CatalogCompactEntry) {
    if ((event.target as Element).closest("a[href],button,input,select,textarea,[data-row-action]"))
      return;
    onNavigate(event, entry);
  }

  return (
    <div className="min-w-0" data-catalog-results>
      <p className="border-b p-3 text-sm text-muted-foreground">
        {visible.length} {visible.length === 1 ? "Caplet" : "Caplets"}
      </p>
      <div
        role="table"
        aria-label="Catalog results"
        aria-rowcount={visible.length + 1}
        className="min-w-0"
      >
        <div role="row" aria-rowindex={1} className="sr-only">
          {["Name", "Description", "Installs", "Status", "Actions"].map((heading) => (
            <span role="columnheader" key={heading}>
              {heading}
            </span>
          ))}
        </div>
        <div
          ref={spacerRef}
          data-result-spacer
          className="relative min-w-0"
          style={{ height: total }}
        >
          {items.map((item) => {
            const entry = visible[item.index];
            if (!entry) return null;
            return (
              <CatalogResultRow
                key={entry.entryKey}
                entry={entry}
                item={item}
                scrollMargin={virtualizer.options.scrollMargin ?? 0}
                installing={installingKey === entry.entryKey}
                onInstall={onInstall}
                onCopy={onCopy}
                onNavigate={onNavigate}
                onClick={rowClick}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

type CatalogResultRowProps = {
  entry: CatalogCompactEntry;
  item: VirtualItem;
  scrollMargin: number;
  installing: boolean;
  onInstall(entry: CatalogCompactEntry): void;
  onCopy(command: string, entry: CatalogCompactEntry): Promise<void>;
  onNavigate(event: ReactMouseEvent<HTMLElement>, entry: CatalogCompactEntry): void;
  onClick(event: ReactMouseEvent<HTMLElement>, entry: CatalogCompactEntry): void;
};

function CatalogResultRow({
  entry,
  item,
  scrollMargin,
  installing,
  onInstall,
  onCopy,
  onNavigate,
  onClick,
}: CatalogResultRowProps) {
  const command = entry.installCommand.text;
  const [copyFailed, setCopyFailed] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);
  const icon = iconFailed ? undefined : entry.icon;
  const displayedWarnings = entry.warnings?.slice(0, 2);
  const remainingWarnings = Math.max((entry.warnings?.length ?? 0) - 2, 0);

  async function copy() {
    try {
      await onCopy(command, entry);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <article
      role="row"
      aria-rowindex={item.index + 2}
      data-result-row
      data-entry-key={entry.entryKey}
      onClick={(event) => onClick(event, entry)}
      className="absolute left-0 top-0 grid w-full min-w-0 cursor-pointer grid-cols-1 gap-2 overflow-hidden border-b p-4 sm:grid-cols-[minmax(10rem,1fr)_minmax(12rem,2fr)_auto] lg:grid-cols-[minmax(12rem,1fr)_minmax(14rem,2fr)_auto_auto_auto] lg:items-center"
      style={{
        height: item.size,
        transform: `translateY(${item.start - scrollMargin}px)`,
      }}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2 overflow-hidden">
        {icon ? (
          <img
            className="size-8 shrink-0 rounded object-cover"
            src={icon.url}
            alt=""
            width={32}
            height={32}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setIconFailed(true)}
          />
        ) : (
          <span
            data-icon-fallback
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded bg-secondary font-medium"
          >
            {entry.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <a
          className="truncate font-medium hover:underline"
          href={catalogDetailHref(entry.entryKey)}
          onClick={(event) => onNavigate(event, entry)}
        >
          {entry.name}
        </a>
        {entry.trustLevel === "official" && (
          <ShieldCheckIcon className="size-4 shrink-0" aria-label="Official" />
        )}
      </div>
      <p role="cell" className="line-clamp-2 min-w-0 overflow-hidden text-sm text-muted-foreground">
        {entry.description}
      </p>
      <div role="cell" className="text-sm">
        {entry.installCountDisplay ?? entry.installCount?.toLocaleString() ?? "—"}
      </div>
      <div
        role="cell"
        className="flex max-h-14 flex-wrap gap-1 overflow-hidden"
        aria-label="Readiness and safety"
      >
        <Badge variant={entry.trustLevel === "official" ? "default" : "secondary"}>
          {entry.trustLevel}
        </Badge>
        <Badge variant="outline">
          <CheckCircle2Icon />
          Setup: {entry.setupReadiness}
        </Badge>
        {entry.authReadiness && <Badge variant="outline">Auth: {entry.authReadiness}</Badge>}
        {entry.projectBindingReadiness && (
          <Badge variant="outline">Project: {entry.projectBindingReadiness}</Badge>
        )}
        {displayedWarnings?.map((warning) => (
          <Badge
            key={warning.code}
            variant={warning.severity === "danger" ? "destructive" : "outline"}
            title={warning.message}
            aria-label={`${warning.label}: ${warning.message}`}
          >
            {warning.label}
          </Badge>
        ))}
        {remainingWarnings > 0 && (
          <Badge variant="outline" aria-label={`${remainingWarnings} more warnings`}>
            +{remainingWarnings}
          </Badge>
        )}
      </div>
      <div role="cell" className="flex min-w-0 flex-wrap items-center gap-2" data-row-action>
        {entry.installCommand.copyable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={copy}
            aria-label={`Copy install command for ${entry.name}`}
          >
            <CopyIcon />
            Copy
          </Button>
        ) : (
          <code
            className="max-w-full select-all overflow-hidden text-ellipsis whitespace-nowrap text-xs"
            title={command}
          >
            {command}
          </code>
        )}
        <Button
          type="button"
          size="sm"
          disabled={installing}
          onClick={() => onInstall(entry)}
          aria-label={`Install ${entry.name}`}
        >
          <DownloadIcon />
          {installing ? "Checking…" : "Install"}
        </Button>
        {copyFailed && (
          <code
            className="w-full select-all overflow-x-auto rounded bg-muted p-2 text-xs"
            role="status"
            aria-live="assertive"
          >
            {command}
          </code>
        )}
      </div>
    </article>
  );
}
