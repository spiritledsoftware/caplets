import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { AlertTriangleIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DashboardApiError, dashboardApi } from "@/lib/api";
import {
  CatalogDetailPage,
  installableDetail,
  type CatalogDetail,
  type CatalogDetailState,
} from "./CatalogDetailPage";
import { CatalogResults } from "./CatalogResults";
import { catalogDetailHref, catalogListHref, catalogLocationFromPath } from "./catalog-route";
import type { CatalogHistoryState, CatalogLocation } from "./catalog-route";
import {
  catalogTags,
  catalogStateFromLocation,
  defaultCatalogState,
  filterCatalogEntries,
  parseCatalogState,
  updateCatalogUrl,
  type CatalogCompactEntry,
  type CatalogCompactResponse,
  type CatalogDiscoveryState,
} from "./catalog-state";

export type CatalogPageProps = {
  data: { updates?: { ready?: boolean; reason?: string } };
  action: (label: string, callback: () => Promise<unknown>) => Promise<void>;
  liveAuthorityAvailable?: boolean;
  liveAuthorityUnavailableReason?: string;
  confirmTyped?: (title: string, description: string, expectedPhrase: string) => Promise<boolean>;
};

const endpoint = "catalog/search?source=official";
const DETAIL_TIMEOUT_MS = 10_000;
const SCOPE_OPTIONS = ["all", "official", "community"];
const SETUP_OPTIONS = ["all", "ready", "required", "unknown"];
const SORT_OPTIONS = ["rank", "name"];

export function CatalogPage({
  data,
  action,
  confirmTyped = async () => false,
  liveAuthorityAvailable = true,
  liveAuthorityUnavailableReason = "Live SQL authority is unavailable. Installation is disabled until storage is ready.",
}: CatalogPageProps) {
  const [entries, setEntries] = useState<CatalogCompactEntry[]>([]);
  const [discovery, setDiscovery] = useState<CatalogDiscoveryState>(defaultCatalogState);
  const [location, setLocation] = useState<CatalogLocation>({ mode: "list" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [detailState, setDetailState] = useState<CatalogDetailState>({ status: "loading" });
  const [installingKey, setInstallingKey] = useState<string>();
  const requestSequence = useRef(0);
  const detailSequence = useRef(0);
  const activeRequestController = useRef<AbortController | undefined>(undefined);
  const activeDetailController = useRef<AbortController | undefined>(undefined);
  const installLock = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const tags = useMemo(() => catalogTags(entries), [entries]);
  const visible = useMemo(() => filterCatalogEntries(entries, discovery), [entries, discovery]);
  const discoveryKey = `${discovery.query}\u0000${discovery.scope}\u0000${discovery.setup}\u0000${discovery.tag}\u0000${discovery.sort}`;
  const installUnavailableReason = liveAuthorityAvailable
    ? undefined
    : liveAuthorityUnavailableReason;

  const load = useCallback(() => {
    activeRequestController.current?.abort();
    const request = ++requestSequence.current;
    const controller = new AbortController();
    activeRequestController.current = controller;
    setLoading(true);
    setError(undefined);

    void dashboardApi<CatalogCompactResponse>(endpoint, { signal: controller.signal })
      .then((response) => {
        if (request !== requestSequence.current) return;

        const nextEntries = response.entries ?? [];
        const normalized = parseCatalogState(
          new URLSearchParams(window.location.search),
          catalogTags(nextEntries),
        );
        setEntries(nextEntries);
        setDiscovery(normalized);

        if (catalogLocationFromPath(window.location.pathname).mode !== "list") return;
        const nextUrl = updateCatalogUrl(window.location.href, normalized);
        const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        if (nextUrl !== currentUrl) {
          window.history.replaceState(window.history.state, "", nextUrl);
        }
      })
      .catch((reason: unknown) => {
        if (request === requestSequence.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (request === requestSequence.current) setLoading(false);
        if (activeRequestController.current === controller) {
          activeRequestController.current = undefined;
        }
      });

    return controller;
  }, []);

  const fetchDetail = useCallback(async (entryKey: string): Promise<CatalogDetail | undefined> => {
    activeDetailController.current?.abort();
    const request = ++detailSequence.current;
    const controller = new AbortController();
    activeDetailController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), DETAIL_TIMEOUT_MS);
    setDetailState({ status: "loading" });

    try {
      const detail = await dashboardApi<CatalogDetail>(
        `catalog/detail?source=official&entryKey=${encodeURIComponent(entryKey)}`,
        { signal: controller.signal },
      );
      if (request !== detailSequence.current) return;

      if (!installableDetail(detail)) {
        setDetailState({
          status: "unreadable",
          detail,
          message: "Readable, copyable Caplet content is unavailable.",
        });
        return;
      }

      setDetailState({ status: "available", detail });
      return detail;
    } catch (reason) {
      if (request !== detailSequence.current) return;

      if (reason instanceof DashboardApiError && reason.status === 404) {
        setDetailState({
          status: "unavailable",
          message: "This Caplet is missing or unavailable.",
        });
      } else {
        const message =
          reason instanceof Error && reason.name !== "AbortError"
            ? reason.message
            : "The detail request timed out.";
        setDetailState({ status: "failed", message });
      }
      return;
    } finally {
      window.clearTimeout(timeout);
      if (activeDetailController.current === controller) {
        activeDetailController.current = undefined;
      }
    }
  }, []);

  useEffect(() => {
    setDiscovery(catalogStateFromLocation());
    setLocation(catalogLocationFromPath(window.location.pathname));
  }, []);
  useEffect(() => {
    let title = "Catalog · Caplets Dashboard";
    if (location.mode === "detail") {
      if (detailState.status === "available" || detailState.status === "unreadable") {
        title = `${detailState.detail.entry.name} · Catalog · Caplets Dashboard`;
      } else if (detailState.status === "unavailable" || detailState.status === "failed") {
        title = "Caplet unavailable · Catalog · Caplets Dashboard";
      }
    }
    document.title = title;
  }, [detailState, location.mode]);

  useEffect(() => {
    load();
    return () => {
      ++requestSequence.current;
      activeRequestController.current?.abort();
      activeRequestController.current = undefined;
    };
  }, [load]);

  useEffect(() => {
    if (location.mode === "detail") {
      void fetchDetail(location.entryKey);
    } else {
      ++detailSequence.current;
      activeDetailController.current?.abort();
      activeDetailController.current = undefined;
    }
  }, [fetchDetail, location]);

  useEffect(
    () => () => {
      ++detailSequence.current;
      activeDetailController.current?.abort();
      activeDetailController.current = undefined;
    },
    [],
  );

  function focusList(previousEntryKey = "") {
    window.setTimeout(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-entry-key="${CSS.escape(previousEntryKey)}"] a`,
      );
      const target =
        row ?? document.querySelector<HTMLElement>("#catalog-title") ?? searchRef.current;
      target?.focus();
    }, 0);
  }

  function restoreListState() {
    setDiscovery(parseCatalogState(new URLSearchParams(window.location.search), tags));
  }

  useEffect(() => {
    const replay = () => {
      const previousEntryKey = location.mode === "detail" ? location.entryKey : "";
      const next = catalogLocationFromPath(window.location.pathname);
      setLocation(next);
      if (next.mode !== "list") return;

      restoreListState();
      focusList(previousEntryKey);
    };
    window.addEventListener("popstate", replay);
    return () => window.removeEventListener("popstate", replay);
  }, [location, tags]);

  function listHrefFromHistory(): string {
    const candidate = (window.history.state as Partial<CatalogHistoryState> | null)
      ?.catalogListHref;
    return typeof candidate === "string" ? candidate : catalogListHref(window.location.pathname);
  }

  function returnToList() {
    const previousEntryKey = location.mode === "detail" ? location.entryKey : "";
    window.history.pushState({}, "", listHrefFromHistory());
    setLocation({ mode: "list" });
    restoreListState();
    focusList(previousEntryKey);
  }

  function openDetail(event: MouseEvent<HTMLElement>, entry: CatalogCompactEntry) {
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

    event.preventDefault();
    const origin = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.pushState(
      { catalogListHref: origin } satisfies CatalogHistoryState,
      "",
      catalogDetailHref(entry.entryKey, window.location.pathname),
    );
    setLocation({ mode: "detail", entryKey: entry.entryKey });
  }

  function change(patch: Partial<CatalogDiscoveryState>) {
    const next = { ...discovery, ...patch };
    window.history.replaceState(
      window.history.state,
      "",
      updateCatalogUrl(window.location.href, next),
    );
    setDiscovery(next);
  }

  async function copy(command: string, name?: string) {
    try {
      await navigator.clipboard.writeText(command);
      toast.success(name ? `Copied install command for ${name}` : "Install command copied");
    } catch (reason) {
      toast.error(reason instanceof Error ? `Copy failed: ${reason.message}` : "Copy failed");
      throw reason;
    }
  }

  async function install(detail: CatalogDetail) {
    if (
      !liveAuthorityAvailable ||
      !installableDetail(detail) ||
      installingKey ||
      installLock.current
    )
      return;

    installLock.current = true;
    const phrase = `install ${detail.entry.id}`;
    try {
      const confirmed = await confirmTyped(
        `Install ${detail.entry.name}`,
        "Confirm the exact Caplet id before installing from the official catalog.",
        phrase,
      );
      if (!confirmed) return;

      setInstallingKey(detail.entry.entryKey);
      await action(`Installed ${detail.entry.name}`, async () =>
        dashboardApi("catalog/install", {
          method: "POST",
          body: JSON.stringify({ source: "official", entryKey: detail.entry.entryKey }),
        }),
      );
    } catch (reason) {
      toast.error(reason instanceof Error ? `Install failed: ${reason.message}` : "Install failed");
    } finally {
      installLock.current = false;
      setInstallingKey(undefined);
    }
  }

  async function rowInstall(entry: CatalogCompactEntry) {
    if (!liveAuthorityAvailable || installingKey) return;

    setInstallingKey(entry.entryKey);
    const detail = await fetchDetail(entry.entryKey);
    setInstallingKey(undefined);
    if (detail) {
      await install(detail);
    } else {
      toast.error(`Could not verify ${entry.name} for installation`);
    }
  }

  function resetDiscovery() {
    change(defaultCatalogState);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }

  if (location.mode === "detail") {
    return (
      <CatalogDetailPage
        state={detailState}
        installing={installingKey === location.entryKey}
        installUnavailableReason={installUnavailableReason}
        onRetry={() => void fetchDetail(location.entryKey)}
        onReturn={returnToList}
        onInstall={(detail) => void install(detail)}
        onCopy={copy}
      />
    );
  }

  let results: ReactNode;
  if (loading) {
    results = (
      <div className="p-6">
        <p>Loading catalog…</p>
        <Button variant="outline" aria-label="Retry loading catalog" onClick={load}>
          <RefreshCwIcon />
          Retry
        </Button>
      </div>
    );
  } else if (error) {
    results = (
      <Alert variant="destructive" className="m-3">
        <AlertTriangleIcon />
        <AlertTitle>Catalog unavailable</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
        <Button onClick={load}>
          <RefreshCwIcon />
          Retry
        </Button>
      </Alert>
    );
  } else if (visible.length > 0) {
    results = (
      <CatalogResults
        discoveryKey={discoveryKey}
        visible={visible}
        installingKey={installingKey}
        installUnavailableReason={installUnavailableReason}
        onNavigate={openDetail}
        onCopy={(command, entry) => copy(command, entry.name)}
        onInstall={(entry) => void rowInstall(entry)}
      />
    );
  } else {
    results = (
      <div className="p-6 text-center">
        <p>No Caplets found</p>
        <Button onClick={resetDiscovery}>Reset</Button>
      </div>
    );
  }

  return (
    <main className="space-y-4" aria-labelledby="catalog-title">
      <header>
        <h1 id="catalog-title" tabIndex={-1} className="text-2xl font-semibold">
          Catalog
        </h1>
        <p className="text-muted-foreground">
          Search the same catalog surface as caplets.dev, then install directly from this operator
          console.
        </p>
      </header>
      <section
        className="flex flex-wrap gap-2 rounded-lg border bg-secondary p-3 text-sm"
        role="note"
      >
        <strong>Not security-reviewed.</strong>
        <span className="text-muted-foreground">Inspect Caplets before installing.</span>
      </section>
      <Card className="overflow-hidden">
        <CardHeader className="gap-3 border-b">
          <div className="flex gap-3">
            <div className="flex-1">
              <CardTitle>Browse catalog</CardTitle>
              <CardDescription>
                Install readiness: {data.updates?.ready === false ? data.updates.reason : "ready"}
              </CardDescription>
            </div>
            <div className="relative">
              <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input
                ref={searchRef}
                className="pl-8"
                value={discovery.query}
                onChange={(event) => change({ query: event.target.value })}
                type="search"
                placeholder="Search Caplets"
                aria-label="Search Caplets"
              />
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            <CatalogSelect
              label="Catalog scope"
              value={discovery.scope}
              onChange={(scope) => change({ scope })}
              options={SCOPE_OPTIONS}
            />
            <CatalogSelect
              label="Catalog setup"
              value={discovery.setup}
              onChange={(setup) => change({ setup })}
              options={SETUP_OPTIONS}
            />
            <CatalogSelect
              label="Catalog tag"
              value={discovery.tag}
              onChange={(tag) => change({ tag })}
              options={["all", ...tags]}
            />
            <CatalogSelect
              label="Catalog sort"
              value={discovery.sort}
              onChange={(sort) => change({ sort: sort === "name" ? "name" : "rank" })}
              options={SORT_OPTIONS}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">{results}</CardContent>
      </Card>
    </main>
  );
}

type CatalogSelectProps = {
  label: string;
  value: string;
  options: readonly string[];
  onChange(value: string): void;
};

function CatalogSelect({ label, value, options, onChange }: CatalogSelectProps) {
  return (
    <select
      className="h-9 rounded-md border bg-background px-3 text-sm"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option}>{option}</option>
      ))}
    </select>
  );
}
