import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  ActivityIcon,
  AlertTriangleIcon,
  BoxIcon,
  BoxesIcon,
  CheckIcon,
  ClipboardListIcon,
  ComputerIcon,
  DatabaseIcon,
  EyeIcon,
  EyeOffIcon,
  HomeIcon,
  KeyIcon,
  KeyRoundIcon,
  LinkIcon,
  LogOutIcon,
  MenuIcon,
  MoonIcon,
  RefreshCwIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SunIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { ThemeProvider, useTheme } from "next-themes";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  adminV2CreateRuntimeRestart,
  adminV2DeleteRemoteClient,
  adminV2DeleteVaultValue,
  adminV2GetDiagnostics,
  adminV2GetHost,
  adminV2GetProjectBinding,
  adminV2GetRemoteClient,
  adminV2GetRemoteLoginRequest,
  adminV2GetRuntime,
  adminV2GetVaultValue,
  adminV2ListActivity,
  adminV2ListCatalogUpdateCandidates,
  adminV2ListEffectiveCaplets,
  adminV2ListLogs,
  adminV2ListRemoteClients,
  adminV2ListRemoteLoginRequests,
  adminV2ListVaultGrants,
  adminV2ListVaultValues,
  adminV2PutVaultValue,
  adminV2UpdateCatalogCaplets,
  adminV2UpdateRemoteClient,
  adminV2UpdateRemoteLoginRequest,
  completeDashboardLogin,
  createDashboardMutationIntent,
  isDashboardUnauthorized,
  logoutDashboardSession,
  pollDashboardLogin,
  restoreDashboardSession,
  revealVaultValue,
  setDashboardSession,
  startDashboardLogin,
  type DashboardLoginPending,
  type DashboardSession,
} from "@/lib/api";
import { EPHEMERAL_REVEAL_TTL_MS, createEphemeralRevealExpiry } from "@/lib/ephemeral-reveal";
import { dashboardBasePath, dashboardPath } from "@/lib/paths";

import { CatalogPage } from "@/components/catalog/CatalogPage";
import { StoredCapletsPage } from "@/components/StoredCapletsPage";
const REVEAL_DURATION_SECONDS = EPHEMERAL_REVEAL_TTL_MS / 1_000;
const ACTION_DISCARDED = Symbol("dashboard-action-discarded");

function catalogInstalledEntries(result: unknown): unknown[] {
  if (!result || typeof result !== "object" || !("installed" in result)) return [];
  return Array.isArray(result.installed) ? result.installed : [];
}

type DashboardActionOptions = {
  clientRevocation?: boolean;
};

type DashboardAction = (
  label: string | ((result: unknown) => string),
  callback: () => Promise<unknown>,
  options?: DashboardActionOptions,
) => Promise<void>;
export function catalogMutationLabel(result: unknown): string {
  const first = catalogInstalledEntries(result)[0];
  const status = first && typeof first === "object" && "status" in first ? first.status : undefined;
  if (status === "content_updated") return "Content updated";
  if (status === "noop") return "Already current";
  if (status === "restored") return "Restored";
  if (status === "installed") return "Installed";
  return "Updated";
}

function catalogIndexingUnavailable(result: unknown): boolean {
  return catalogInstalledEntries(result).some((entry) => {
    if (!entry || typeof entry !== "object" || !("catalogIndexing" in entry)) return false;
    const indexing = entry.catalogIndexing;
    return (
      indexing !== null &&
      typeof indexing === "object" &&
      "status" in indexing &&
      indexing.status === "unavailable"
    );
  });
}

type RouteKey =
  | "overview"
  | "access"
  | "caplets"
  | "stored-caplets"
  | "catalog"
  | "vault"
  | "runtime"
  | "activity"
  | "settings";

type Summary = {
  host?: { baseUrl?: string; version?: string };
  attention?: Array<{ label: string; severity?: string; kind?: string }>;
  sections?: Record<string, unknown>;
  error?: string;
};

type CapletRecord = Record<string, unknown> & {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  kind?: string;
  source?: string;
  updateState?: string;
  authRequired?: boolean | "true" | "false";
  setupRequired?: boolean | "true" | "false";
  projectBindingRequired?: boolean | "true" | "false";
};

type DashboardPageProgress = {
  nextCursor?: string;
  loadingMore?: boolean;
  paginationError?: string;
};

type ProjectBindingSnapshot = {
  state: "connected" | "disconnected";
  affectedCaplets: string[];
  actions: Array<{
    id: string;
    label: string;
    enabled: boolean;
    reason?: string;
  }>;
};

type DashboardData = {
  summary?: Summary;
  caplets?: DashboardPageProgress & {
    caplets?: Array<CapletRecord>;
    error?: string;
  };
  clients?: DashboardPageProgress & {
    clients?: Array<Record<string, string>>;
    error?: string;
  };
  pending?: DashboardPageProgress & {
    pendingLogins?: Array<Record<string, string>>;
    error?: string;
  };
  vault?: {
    values?: Array<Record<string, string | number>>;
    grants?: Array<Record<string, unknown>>;
    valuesNextCursor?: string;
    valuesLoadingMore?: boolean;
    valuesPaginationError?: string;
    grantsNextCursor?: string;
    grantsLoadingMore?: boolean;
    grantsPaginationError?: string;
    error?: string;
  };
  runtime?: { runtime?: Record<string, string>; daemon?: Record<string, unknown>; error?: string };
  diagnostics?: { status?: string; checks?: Array<Record<string, string>>; error?: string };
  activity?: { entries?: Array<Record<string, unknown>>; error?: string };
  logs?: { entries?: Array<Record<string, unknown>>; error?: string };
  projectBinding?: ProjectBindingSnapshot | { error: string };
  updates?: DashboardPageProgress & {
    ready?: boolean;
    reason?: string;
    updates?: Array<{ id?: string; status?: string; risk?: unknown }>;
    error?: string;
  };
};

export type DashboardCollectionKey =
  | "caplets"
  | "clients"
  | "pending"
  | "vaultValues"
  | "vaultGrants"
  | "updates";

type DashboardCursorPage<T> = {
  items: T[];
  nextCursor?: string;
};

type DashboardPageStatus = {
  loadingMore: boolean;
  paginationError?: string;
};

function dashboardCursorSets(): Record<DashboardCollectionKey, Set<string>> {
  return {
    caplets: new Set(),
    clients: new Set(),
    pending: new Set(),
    vaultValues: new Set(),
    vaultGrants: new Set(),
    updates: new Set(),
  };
}

export class DashboardPaginationLocks {
  private readonly owners = new Map<DashboardCollectionKey, symbol>();

  reset(): void {
    this.owners.clear();
  }

  tryAcquire(key: DashboardCollectionKey): symbol | undefined {
    if (this.owners.has(key)) return undefined;
    const owner = Symbol(key);
    this.owners.set(key, owner);
    return owner;
  }

  release(key: DashboardCollectionKey, owner: symbol | undefined): void {
    if (owner !== undefined && this.owners.get(key) === owner) {
      this.owners.delete(key);
    }
  }
}

function dashboardCursor(value: unknown, property = "nextCursor"): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cursor = Reflect.get(value, property);
  return typeof cursor === "string" ? cursor : undefined;
}

function withDashboardPageStatus(
  data: DashboardData,
  key: DashboardCollectionKey,
  status: DashboardPageStatus,
): DashboardData {
  switch (key) {
    case "caplets":
      return { ...data, caplets: { ...data.caplets, ...status } };
    case "clients":
      return { ...data, clients: { ...data.clients, ...status } };
    case "pending":
      return { ...data, pending: { ...data.pending, ...status } };
    case "updates":
      return { ...data, updates: { ...data.updates, ...status } };
    case "vaultValues":
      return {
        ...data,
        vault: {
          ...data.vault,
          valuesLoadingMore: status.loadingMore,
          valuesPaginationError: status.paginationError,
        },
      };
    case "vaultGrants":
      return {
        ...data,
        vault: {
          ...data.vault,
          grantsLoadingMore: status.loadingMore,
          grantsPaginationError: status.paginationError,
        },
      };
  }
}

const routes: Array<{
  key: RouteKey;
  label: string;
  href: string;
  icon: typeof HomeIcon;
}> = [
  { key: "overview", label: "Overview", href: dashboardPath(), icon: HomeIcon },
  { key: "access", label: "Access", href: dashboardPath("access"), icon: ShieldCheckIcon },
  { key: "caplets", label: "Caplets", href: dashboardPath("caplets"), icon: BoxesIcon },
  {
    key: "stored-caplets",
    label: "Stored Caplets",
    href: dashboardPath("stored-caplets"),
    icon: DatabaseIcon,
  },
  { key: "catalog", label: "Catalog", href: dashboardPath("catalog"), icon: BoxIcon },
  { key: "vault", label: "Vault", href: dashboardPath("vault"), icon: KeyRoundIcon },
  { key: "runtime", label: "Runtime", href: dashboardPath("runtime"), icon: TerminalIcon },
  { key: "activity", label: "Activity", href: dashboardPath("activity"), icon: ActivityIcon },
  { key: "settings", label: "Settings", href: dashboardPath("settings"), icon: ClipboardListIcon },
];

function routeHref(route: RouteKey): string {
  return routes.find((item) => item.key === route)?.href ?? dashboardPath();
}

function routeLabel(route: RouteKey): string {
  return routes.find((item) => item.key === route)?.label ?? "Overview";
}

const dashboardThemeColors: Record<"light" | "dark", string> = {
  light: "#f6f0df",
  dark: "#1d1b16",
};

type DashboardTheme = "light" | "dark" | "system";

function dashboardBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

type ConfirmationOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  expectedPhrase?: string;
};

type ConfirmationResult = boolean | string;

type ConfirmationRequest = ConfirmationOptions & {
  resolve: (confirmed: ConfirmationResult) => void;
  finalFocus?: HTMLElement | null;
};

const ConfirmContext = createContext<
  ((options: ConfirmationOptions) => Promise<ConfirmationResult>) | null
>(null);
const ConfirmDismissContext = createContext<(() => void) | null>(null);

function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside DashboardApp.");
  return confirm;
}

function useDismissConfirmation() {
  const dismissConfirmation = useContext(ConfirmDismissContext);
  if (!dismissConfirmation)
    throw new Error("useDismissConfirmation must be used inside DashboardApp.");
  return dismissConfirmation;
}

function useActionConfirm() {
  const confirm = useConfirm();
  return {
    confirmAction: async (title: string, description: string) =>
      Boolean(await confirm({ title, description, confirmLabel: "Continue" })),
    confirmDestructive: async (title: string, description: string, confirmLabel = "Delete") =>
      Boolean(
        await confirm({
          title,
          description,
          confirmLabel,
          destructive: true,
        }),
      ),
    confirmTyped: async (title: string, description: string, expectedPhrase: string) =>
      Boolean(
        await confirm({
          title,
          description,
          expectedPhrase,
          confirmLabel: "Confirm",
          destructive: true,
        }),
      ),
  };
}

export function DashboardApp({ initialRoute = "overview" }: { initialRoute?: RouteKey }) {
  const [route, setRoute] = useState<RouteKey>(initialRoute);
  const [session, setSession] = useState<DashboardSession>();
  const [data, setData] = useState<DashboardData>({});
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(true);
  const [authCommand, setAuthCommand] = useState("");
  const [authMessage, setAuthMessage] = useState("Restoring dashboard session…");
  const [confirmation, setConfirmation] = useState<ConfirmationRequest>();
  const [runtimeRestartPending, setRuntimeRestartPending] = useState(false);
  const confirmationRef = useRef<ConfirmationRequest | undefined>(undefined);
  const mutationRevisionRef = useRef(0);
  const pendingClientRevocationsRef = useRef(0);
  const clientRevocationWaitersRef = useRef(new Set<() => void>());
  const runtimeRestartPendingRef = useRef(false);
  const paginationGenerationRef = useRef(0);
  const paginationLocksRef = useRef(new DashboardPaginationLocks());
  const paginationCursorsRef = useRef(dashboardCursorSets());

  const resolveConfirmation = useCallback((confirmed: ConfirmationResult) => {
    const activeConfirmation = confirmationRef.current;
    if (!activeConfirmation) return;
    confirmationRef.current = undefined;
    activeConfirmation.resolve(confirmed);
    setConfirmation(undefined);
  }, []);

  const confirm = useCallback(
    (options: ConfirmationOptions) => {
      const finalFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return new Promise<ConfirmationResult>((resolve) => {
        resolveConfirmation(false);
        const request = { ...options, finalFocus, resolve };
        confirmationRef.current = request;
        setConfirmation(request);
      });
    },
    [resolveConfirmation],
  );

  const dismissConfirmation = useCallback(() => resolveConfirmation(false), [resolveConfirmation]);

  function beginClientRevocationRefreshBarrier(): () => void {
    pendingClientRevocationsRef.current += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingClientRevocationsRef.current -= 1;
      if (pendingClientRevocationsRef.current !== 0) return;
      for (const resolve of clientRevocationWaitersRef.current) resolve();
      clientRevocationWaitersRef.current.clear();
    };
  }

  async function waitForClientRevocationBarrier(): Promise<void> {
    while (pendingClientRevocationsRef.current !== 0) {
      await new Promise<void>((resolve) => {
        clientRevocationWaitersRef.current.add(resolve);
      });
    }
  }

  useEffect(() => {
    let cancelled = false;
    void restoreSessionWithRetry(0, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  function endDashboardSession(message = "Authorization required.") {
    paginationGenerationRef.current += 1;
    paginationLocksRef.current.reset();
    paginationCursorsRef.current = dashboardCursorSets();
    setSession(undefined);
    setDashboardSession(undefined);
    setData({});
    setAuthCommand("");
    setAuthMessage(message);
    setLoading(false);
    setDataLoading(false);
  }

  async function restoreSessionWithRetry(attempt: number, cancelled: () => boolean) {
    setLoading(true);
    try {
      const result = await restoreDashboardSession();
      if (cancelled()) return;
      setSession(result.session);
      setDashboardSession(result.session);
      const refreshed = await refresh();
      if (!cancelled() && refreshed) setLoading(false);
    } catch (error) {
      if (cancelled()) return;
      if (isDashboardUnauthorized(error)) {
        endDashboardSession();
        return;
      }
      setAuthMessage("Reconnecting to the Current Host…");
      window.setTimeout(
        () => restoreSessionWithRetry(attempt + 1, cancelled),
        Math.min(10_000, 1_000 + attempt * 1_000),
      );
    }
  }

  async function refresh(expectedMutationRevision = mutationRevisionRef.current): Promise<boolean> {
    const paginationGeneration = ++paginationGenerationRef.current;
    paginationLocksRef.current.reset();
    paginationCursorsRef.current = dashboardCursorSets();
    setData((current) => ({
      ...current,
      caplets: current.caplets
        ? {
            ...current.caplets,
            nextCursor: undefined,
            loadingMore: false,
            paginationError: undefined,
          }
        : undefined,
      clients: current.clients
        ? {
            ...current.clients,
            nextCursor: undefined,
            loadingMore: false,
            paginationError: undefined,
          }
        : undefined,
      pending: current.pending
        ? {
            ...current.pending,
            nextCursor: undefined,
            loadingMore: false,
            paginationError: undefined,
          }
        : undefined,
      vault: current.vault
        ? {
            ...current.vault,
            valuesNextCursor: undefined,
            valuesLoadingMore: false,
            valuesPaginationError: undefined,
            grantsNextCursor: undefined,
            grantsLoadingMore: false,
            grantsPaginationError: undefined,
          }
        : undefined,
      updates: current.updates
        ? {
            ...current.updates,
            nextCursor: undefined,
            loadingMore: false,
            paginationError: undefined,
          }
        : undefined,
    }));
    setDataLoading(true);
    try {
      const [
        summary,
        caplets,
        clients,
        pending,
        vault,
        runtime,
        diagnostics,
        activity,
        logs,
        projectBinding,
        updates,
      ] = await Promise.all([
        load(adminV2GetHost()),
        load(
          adminV2ListEffectiveCaplets({}).then((page) => ({
            caplets: page.items,
            nextCursor: page.nextCursor,
          })),
        ),
        load(
          adminV2ListRemoteClients({}).then((page) => ({
            clients: page.items.map(({ clientId, clientLabel, role }) => ({
              clientId,
              clientLabel,
              role,
            })),
            nextCursor: page.nextCursor,
          })),
        ),
        load(
          adminV2ListRemoteLoginRequests({}).then((page) => ({
            pendingLogins: page.items.map(({ flowId, clientLabel, requestedRole, status }) => ({
              flowId,
              clientLabel,
              requestedRole,
              status,
            })),
            nextCursor: page.nextCursor,
          })),
        ),
        load(
          Promise.all([adminV2ListVaultValues({}), adminV2ListVaultGrants({})]).then(
            ([values, grants]) => ({
              values: values.items.map(({ key, generation, valueBytes, createdAt, updatedAt }) => ({
                key,
                generation,
                valueBytes,
                createdAt,
                updatedAt,
              })),
              valuesNextCursor: values.nextCursor,
              grants: grants.items.map((grant) => ({ ...grant })),
              grantsNextCursor: grants.nextCursor,
            }),
          ),
        ),
        load(
          adminV2GetRuntime().then(({ runtime, daemon }) => ({
            runtime: { ...runtime, publicOrigin: runtime.publicOrigin ?? "" },
            daemon,
          })),
        ),
        load(adminV2GetDiagnostics()),
        load(adminV2ListActivity({ limit: 50 }).then((page) => ({ entries: page.items }))),
        load(adminV2ListLogs({ limit: 100 }).then((page) => ({ entries: page.items }))),
        load(adminV2GetProjectBinding()),
        load(
          adminV2ListCatalogUpdateCandidates({}).then((page) => ({
            ready: true,
            updates: page.items,
            nextCursor: page.nextCursor,
          })),
        ),
      ]);
      await waitForClientRevocationBarrier();
      if (
        paginationGeneration !== paginationGenerationRef.current ||
        expectedMutationRevision !== mutationRevisionRef.current
      )
        return false;
      const cursors = dashboardCursorSets();
      const seed = (key: DashboardCollectionKey, cursor: string | undefined) => {
        if (cursor !== undefined) cursors[key].add(cursor);
      };
      seed("caplets", dashboardCursor(caplets));
      seed("clients", dashboardCursor(clients));
      seed("pending", dashboardCursor(pending));
      seed("vaultValues", dashboardCursor(vault, "valuesNextCursor"));
      seed("vaultGrants", dashboardCursor(vault, "grantsNextCursor"));
      seed("updates", dashboardCursor(updates));
      paginationCursorsRef.current = cursors;
      setData({
        summary,
        caplets,
        clients,
        pending,
        vault,
        runtime,
        diagnostics,
        activity,
        logs,
        projectBinding,
        updates,
      });
      return true;
    } catch (error) {
      if (isDashboardUnauthorized(error)) {
        endDashboardSession();
        return false;
      }
      throw error;
    } finally {
      if (paginationGeneration === paginationGenerationRef.current) setDataLoading(false);
    }
  }

  async function load<T>(request: Promise<T>): Promise<T | { error: string }> {
    try {
      return await request;
    } catch (error) {
      if (isDashboardUnauthorized(error)) throw error;
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function loadMoreDashboardPage<T>(
    key: DashboardCollectionKey,
    label: string,
    cursor: string | undefined,
    request: (cursor: string) => Promise<DashboardCursorPage<T>>,
    append: (data: DashboardData, page: DashboardCursorPage<T>) => DashboardData,
  ): Promise<void> {
    if (!cursor) return;
    const lockOwner = paginationLocksRef.current.tryAcquire(key);
    if (lockOwner === undefined) return;
    const generation = paginationGenerationRef.current;
    setData((current) =>
      withDashboardPageStatus(current, key, {
        loadingMore: true,
        paginationError: undefined,
      }),
    );
    try {
      const page = await request(cursor);
      if (generation !== paginationGenerationRef.current) return;
      if (page.nextCursor !== undefined && paginationCursorsRef.current[key].has(page.nextCursor)) {
        throw new Error(`${label} pagination returned a repeated cursor.`);
      }
      if (page.nextCursor !== undefined) {
        paginationCursorsRef.current[key].add(page.nextCursor);
      }
      setData((current) => append(current, page));
    } catch (error) {
      if (generation !== paginationGenerationRef.current) return;
      if (isDashboardUnauthorized(error)) {
        endDashboardSession();
        return;
      }
      setData((current) =>
        withDashboardPageStatus(current, key, {
          loadingMore: false,
          paginationError: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      paginationLocksRef.current.release(key, lockOwner);
    }
  }

  function loadMoreDashboardCollection(key: DashboardCollectionKey): Promise<void> {
    switch (key) {
      case "caplets":
        return loadMoreDashboardPage(
          key,
          "Effective Caplets",
          data.caplets?.nextCursor,
          (cursor) =>
            adminV2ListEffectiveCaplets({ cursor }).then((page) => ({
              items: page.items,
              nextCursor: page.nextCursor,
            })),
          (current, page) => ({
            ...current,
            caplets: {
              ...current.caplets,
              caplets: [...(current.caplets?.caplets ?? []), ...page.items],
              nextCursor: page.nextCursor,
              loadingMore: false,
              paginationError: undefined,
            },
          }),
        );
      case "clients":
        return loadMoreDashboardPage(
          key,
          "Remote clients",
          data.clients?.nextCursor,
          (cursor) =>
            adminV2ListRemoteClients({ cursor }).then((page) => ({
              items: page.items.map(({ clientId, clientLabel, role }) => ({
                clientId,
                clientLabel,
                role,
              })),
              nextCursor: page.nextCursor,
            })),
          (current, page) => ({
            ...current,
            clients: {
              ...current.clients,
              clients: [...(current.clients?.clients ?? []), ...page.items],
              nextCursor: page.nextCursor,
              loadingMore: false,
              paginationError: undefined,
            },
          }),
        );
      case "pending":
        return loadMoreDashboardPage(
          key,
          "Remote login requests",
          data.pending?.nextCursor,
          (cursor) =>
            adminV2ListRemoteLoginRequests({ cursor }).then((page) => ({
              items: page.items.map(({ flowId, clientLabel, requestedRole, status }) => ({
                flowId,
                clientLabel,
                requestedRole,
                status,
              })),
              nextCursor: page.nextCursor,
            })),
          (current, page) => ({
            ...current,
            pending: {
              ...current.pending,
              pendingLogins: [...(current.pending?.pendingLogins ?? []), ...page.items],
              nextCursor: page.nextCursor,
              loadingMore: false,
              paginationError: undefined,
            },
          }),
        );
      case "vaultValues":
        return loadMoreDashboardPage(
          key,
          "Vault values",
          data.vault?.valuesNextCursor,
          (cursor) =>
            adminV2ListVaultValues({ cursor }).then((page) => ({
              items: page.items.map(
                ({ key: storedKey, generation, valueBytes, createdAt, updatedAt }) => ({
                  key: storedKey,
                  generation,
                  valueBytes,
                  createdAt,
                  updatedAt,
                }),
              ),
              nextCursor: page.nextCursor,
            })),
          (current, page) => ({
            ...current,
            vault: {
              ...current.vault,
              values: [...(current.vault?.values ?? []), ...page.items],
              valuesNextCursor: page.nextCursor,
              valuesLoadingMore: false,
              valuesPaginationError: undefined,
            },
          }),
        );
      case "vaultGrants":
        return loadMoreDashboardPage(
          key,
          "Vault grants",
          data.vault?.grantsNextCursor,
          (cursor) =>
            adminV2ListVaultGrants({ cursor }).then((page) => ({
              items: page.items.map((grant) => ({ ...grant })),
              nextCursor: page.nextCursor,
            })),
          (current, page) => ({
            ...current,
            vault: {
              ...current.vault,
              grants: [...(current.vault?.grants ?? []), ...page.items],
              grantsNextCursor: page.nextCursor,
              grantsLoadingMore: false,
              grantsPaginationError: undefined,
            },
          }),
        );
      case "updates":
        return loadMoreDashboardPage(
          key,
          "Catalog update candidates",
          data.updates?.nextCursor,
          (cursor) =>
            adminV2ListCatalogUpdateCandidates({ cursor }).then((page) => ({
              items: page.items,
              nextCursor: page.nextCursor,
            })),
          (current, page) => ({
            ...current,
            updates: {
              ...current.updates,
              updates: [...(current.updates?.updates ?? []), ...page.items],
              nextCursor: page.nextCursor,
              loadingMore: false,
              paginationError: undefined,
            },
          }),
        );
    }
  }

  async function startAuthorization() {
    setLoading(true);
    try {
      const pending = await startDashboardLogin("Browser Dashboard");
      setAuthCommand(pending.approvalCommand);
      setAuthMessage(
        "Run this command on the Current Host. This page will finish automatically after approval.",
      );
      window.setTimeout(
        () => void pollAuthorization(pending),
        Math.max(1, pending.intervalSeconds || 5) * 1000,
      );
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : String(error));
      setLoading(false);
    }
  }

  async function pollAuthorization(
    pending: Pick<DashboardLoginPending, "flowId" | "pendingCompletionSecret" | "intervalSeconds">,
  ) {
    try {
      const result = await pollDashboardLogin(pending.flowId, pending.pendingCompletionSecret);
      if (result.status !== "approved") {
        if (result.status === "denied" || result.status === "expired") {
          setAuthCommand("");
          setAuthMessage(`Pending login was ${result.status}. Start a new browser approval.`);
          setLoading(false);
          return;
        }
        window.setTimeout(
          () => void pollAuthorization(pending),
          Math.max(1, pending.intervalSeconds || 5) * 1000,
        );
        return;
      }
      const completed = await completeDashboardLogin(
        pending.flowId,
        pending.pendingCompletionSecret,
      );
      setSession(completed.session);
      setDashboardSession(completed.session);
      const refreshed = await refresh();
      if (refreshed) setLoading(false);
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : String(error));
      setLoading(false);
    }
  }

  const action: DashboardAction = async (label, callback, options = {}) => {
    const releaseClientRevocationBarrier = options.clientRevocation
      ? beginClientRevocationRefreshBarrier()
      : undefined;
    try {
      const result = await callback();
      if (result === ACTION_DISCARDED) return;
      const mutationRevision = ++mutationRevisionRef.current;
      releaseClientRevocationBarrier?.();
      const refreshed = await refresh(mutationRevision);
      if (refreshed) {
        toast.success(typeof label === "function" ? label(result) : label);
        if (catalogIndexingUnavailable(result)) {
          toast.warning("Catalog indexing unavailable; the committed update is still installed.");
        }
      }
    } catch (error) {
      if (isDashboardUnauthorized(error)) {
        endDashboardSession();
        return;
      }
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      releaseClientRevocationBarrier?.();
    }
  };

  async function requestRuntimeRestart(): Promise<void> {
    if (runtimeRestartPendingRef.current) return;
    runtimeRestartPendingRef.current = true;
    setRuntimeRestartPending(true);
    try {
      if (
        !(await confirm({
          title: "Restart runtime?",
          description:
            "This interrupts active Current Host requests while the daemon restarts. Type restart runtime to continue.",
          expectedPhrase: "restart runtime",
          confirmLabel: "Restart runtime",
          destructive: true,
        }))
      )
        return;
      const intent = createDashboardMutationIntent();
      await action("Restart requested", () => adminV2CreateRuntimeRestart(intent));
    } finally {
      runtimeRestartPendingRef.current = false;
      setRuntimeRestartPending(false);
    }
  }

  async function logout() {
    try {
      await logoutDashboardSession();
      endDashboardSession();
      toast.success("Logged out");
    } catch (error) {
      if (isDashboardUnauthorized(error)) {
        endDashboardSession();
        return;
      }
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  function navigate(next: RouteKey, href: string) {
    setRoute(next);
    window.history.pushState({ route: next }, `${routeLabel(next)} · Caplets Dashboard`, href);
  }

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    document.title = `${routeLabel(route)} · Caplets Dashboard`;
  }, [route]);

  let content: ReactNode;
  if (!session) {
    content = (
      <main id="caplets-dashboard" className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <Badge className="w-fit" variant="secondary">
              Operator Client required
            </Badge>
            <CardTitle className="text-3xl">Caplets Admin Dashboard</CardTitle>
            <CardDescription role="status" aria-live="polite" aria-busy={loading}>
              {authMessage}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Button onClick={startAuthorization} disabled={loading || Boolean(authCommand)}>
              <ShieldCheckIcon data-icon="inline-start" />
              Authorize this browser
            </Button>
            {authCommand ? (
              <>
                <div className="grid gap-2 rounded-lg border bg-muted p-3">
                  <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-all text-sm text-foreground">
                    <code>{authCommand}</code>
                  </pre>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="Copy browser approval command"
                    onClick={() => void copyToClipboard(authCommand, "Approval command copied")}
                  >
                    <ClipboardListIcon data-icon="inline-start" />
                    Copy command
                  </Button>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setAuthCommand("");
                    setAuthMessage("Authorization required.");
                    setLoading(false);
                  }}
                >
                  Start over
                </Button>
              </>
            ) : null}
          </CardContent>
        </Card>
        <Toaster />
      </main>
    );
  } else {
    const isDevelopmentSession = session.operatorClientId === "development_unauthenticated";
    content = (
      <ConfirmContext.Provider value={confirm}>
        <ConfirmDismissContext.Provider value={dismissConfirmation}>
          <TooltipProvider>
            <SidebarProvider>
              <a
                href="#dashboard-main"
                className="sr-only z-50 rounded-lg bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
              >
                Skip to dashboard content
              </a>
              <Sidebar id="dashboard-sidebar">
                <SidebarHeader>
                  <div className="flex items-center gap-2 px-2 py-1">
                    <img
                      src={dashboardPath("icon-header-dark.png")}
                      alt=""
                      className="size-8 rounded-lg border border-border bg-card object-cover"
                      width={32}
                      height={32}
                    />
                    <div>
                      <div className="font-semibold">Caplets</div>
                      <div className="text-xs text-muted-foreground">Operator console</div>
                    </div>
                  </div>
                </SidebarHeader>
                <SidebarContent>
                  <SidebarGroup>
                    <SidebarGroupLabel>Dashboard</SidebarGroupLabel>
                    <SidebarGroupContent>
                      <nav aria-label="Dashboard">
                        <SidebarMenu>
                          {routes.map((item) => (
                            <DashboardNavItem
                              key={item.key}
                              item={item}
                              active={route === item.key}
                              onNavigate={navigate}
                            />
                          ))}
                        </SidebarMenu>
                      </nav>
                    </SidebarGroupContent>
                  </SidebarGroup>
                </SidebarContent>
                <SidebarFooter>
                  <div className="grid gap-3">
                    <DashboardThemeSelect />
                    {isDevelopmentSession ? (
                      <div className="rounded-lg border bg-secondary px-3 py-2 text-xs text-secondary-foreground">
                        <div className="font-mono font-bold">No-auth mode</div>
                        <div className="mt-1 text-muted-foreground">
                          Operator checks are bypassed locally.
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-end px-2">
                        <TooltipIconButton
                          variant="ghost"
                          size="icon"
                          label="Logout"
                          onClick={() => void logout()}
                        >
                          <LogOutIcon />
                        </TooltipIconButton>
                      </div>
                    )}
                  </div>
                </SidebarFooter>
              </Sidebar>
              <SidebarInset id="dashboard-main" tabIndex={-1}>
                <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
                  <SidebarTrigger className="md:size-11" aria-controls="dashboard-sidebar">
                    <MenuIcon />
                  </SidebarTrigger>
                  <Separator orientation="vertical" className="h-6" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-muted-foreground">
                      {data.summary?.host?.baseUrl ?? "Current Host"}
                    </div>
                  </div>
                  <TooltipIconButton
                    variant="outline"
                    size="icon"
                    className="md:size-11"
                    label={dataLoading ? "Refreshing dashboard" : "Refresh dashboard"}
                    disabled={dataLoading}
                    aria-busy={dataLoading}
                    onClick={() => action("Dashboard refreshed", refresh)}
                  >
                    <RefreshCwIcon className={dataLoading ? "animate-spin" : undefined} />
                  </TooltipIconButton>
                </header>
                <div className="flex flex-col gap-4 p-4 md:p-6">
                  <Page
                    route={route}
                    data={data}
                    loading={dataLoading}
                    action={action}
                    loadMore={loadMoreDashboardCollection}
                    runtimeRestartPending={runtimeRestartPending}
                    requestRuntimeRestart={requestRuntimeRestart}
                    session={session}
                  />
                </div>
              </SidebarInset>
              <Toaster />
              <ConfirmationDialog request={confirmation} onResolve={resolveConfirmation} />
            </SidebarProvider>
          </TooltipProvider>
        </ConfirmDismissContext.Provider>
      </ConfirmContext.Provider>
    );
  }

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="caplets-dashboard-theme"
    >
      {content}
    </ThemeProvider>
  );
}

function DashboardThemeSelect() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const browserTheme = resolvedTheme === "dark" ? "dark" : "light";
    document.documentElement.style.colorScheme = browserTheme;
    const themeColor =
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]') ??
      document.head.appendChild(
        Object.assign(document.createElement("meta"), { name: "theme-color" }),
      );
    themeColor.content = dashboardThemeColors[browserTheme];
  }, [mounted, resolvedTheme]);

  const selectedTheme: DashboardTheme =
    mounted && (theme === "light" || theme === "dark" || theme === "system") ? theme : "system";

  return (
    <label className="grid gap-1.5 px-2">
      <span className="text-xs font-medium text-muted-foreground">Color scheme</span>
      <Select value={selectedTheme} onValueChange={(next) => next && setTheme(next)}>
        <SelectTrigger aria-label="Color scheme" className="w-full bg-card">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="light">
              <SunIcon />
              Light
            </SelectItem>
            <SelectItem value="dark">
              <MoonIcon />
              Dark
            </SelectItem>
            <SelectItem value="system">
              <ComputerIcon />
              System
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
  );
}

function DashboardNavItem({
  item,
  active,
  onNavigate,
}: {
  item: { key: RouteKey; label: string; href: string; icon: typeof HomeIcon };
  active: boolean;
  onNavigate: (next: RouteKey, href: string) => void;
}) {
  const { setOpenMobile } = useSidebar();
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        render={
          <a
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(item.key, item.href);
              setOpenMobile(false);
            }}
          />
        }
      >
        <Icon />
        <span>{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function Page({
  route,
  data,
  loading,
  action,
  loadMore,
  session,
  runtimeRestartPending,
  requestRuntimeRestart,
}: {
  route: RouteKey;
  data: DashboardData;
  loading: boolean;
  session: DashboardSession;
  action: DashboardAction;
  loadMore: (key: DashboardCollectionKey) => Promise<void>;
  runtimeRestartPending: boolean;
  requestRuntimeRestart: () => Promise<void>;
}) {
  const { confirmAction, confirmDestructive, confirmTyped } = useActionConfirm();
  if (route === "access")
    return <AccessPage data={data} loading={loading} action={action} onLoadMore={loadMore} />;
  if (route === "caplets")
    return <CapletsPage data={data} loading={loading} action={action} onLoadMore={loadMore} />;
  if (route === "stored-caplets")
    return (
      <StoredCapletsPage
        action={action}
        confirmAction={confirmAction}
        confirmDestructive={confirmDestructive}
        confirmTyped={confirmTyped}
      />
    );
  if (route === "catalog")
    return <CatalogPage data={data} action={action} confirmTyped={confirmTyped} />;
  if (route === "vault")
    return <VaultPage data={data} loading={loading} action={action} onLoadMore={loadMore} />;
  if (route === "runtime")
    return (
      <RuntimePage
        data={data}
        loading={loading}
        restartPending={runtimeRestartPending}
        requestRestart={requestRuntimeRestart}
      />
    );
  if (route === "activity") return <ActivityPage data={data} loading={loading} />;
  if (route === "settings") return <SettingsPage session={session} summary={data.summary} />;
  return <OverviewPage data={data} loading={loading} />;
}

function ConfirmationDialog({
  request,
  onResolve,
}: {
  request?: ConfirmationRequest;
  onResolve: (confirmed: ConfirmationResult) => void;
}) {
  const [typed, setTyped] = useState("");

  useEffect(() => setTyped(""), [request]);
  if (!request) return null;

  const disabled = request.expectedPhrase ? typed !== request.expectedPhrase : false;
  return (
    <Dialog open onOpenChange={(open) => !open && onResolve(false)}>
      <DialogContent showCloseButton={false} finalFocus={() => request.finalFocus ?? undefined}>
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogDescription>{request.description}</DialogDescription>
        </DialogHeader>
        {request.expectedPhrase ? (
          <label className="grid gap-1.5 text-sm">
            <span className="font-mono text-xs font-bold text-muted-foreground">
              Type {request.expectedPhrase} to continue
            </span>
            <Input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              aria-label={`Type ${request.expectedPhrase} to confirm`}
              autoFocus
            />
          </label>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onResolve(false)}>
            Cancel
          </Button>
          <Button
            variant={request.destructive ? "destructive" : "default"}
            disabled={disabled}
            onClick={() => onResolve(request.expectedPhrase ? typed : true)}
          >
            {request.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function copyToClipboard(text: string, label = "Copied") {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Copy failed.");
  }
}

function TooltipIconButton({
  label,
  children,
  side = "top",
  size = "icon-sm",
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  label: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button {...props} size={size} aria-label={label}>
            {children}
          </Button>
        }
      />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

function TooltipIconBadge({
  label,
  children,
  side = "top",
  className = "",
  ...props
}: Omit<ComponentProps<typeof Badge>, "children"> & {
  label: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            {...props}
            role="img"
            aria-label={label}
            className={`!size-6 !rounded-full !px-0 !py-0 ${className}`}
          >
            {children}
            <span className="sr-only">{label}</span>
          </Badge>
        }
      />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

function OverviewPage({ data, loading }: { data: DashboardData; loading: boolean }) {
  const attention = data.summary?.attention ?? [];
  const pendingCount = data.pending?.pendingLogins?.length ?? 0;
  const updateSummary = catalogUpdateSummary(data.updates?.updates ?? []);
  const runtimeStatus = data.runtime?.runtime?.status ?? data.diagnostics?.status ?? "unknown";
  const projectBindingState =
    data.projectBinding && "state" in data.projectBinding
      ? data.projectBinding.state
      : "not configured";
  const projectBindingConnected = projectBindingState === "connected";
  const vaultGrantCount = data.vault?.grants?.length ?? 0;
  const inventoryCount = (data.caplets?.caplets ?? []).length;
  const attentionItems = [
    ...(pendingCount
      ? [
          {
            label: `${pendingCount} pending approvals`,
            href: routeHref("access"),
            detail: "Remote clients are waiting for a role decision.",
            severity: "warning" as const,
          },
        ]
      : []),
    ...(updateSummary.severity === "warning"
      ? [
          {
            label: updateSummary.label,
            href: routeHref("catalog"),
            detail: "Catalog updates need risk review before install actions.",
            severity: "warning" as const,
          },
        ]
      : []),
    ...((!projectBindingConnected
      ? [
          {
            label: `Project Binding ${projectBindingState}`,
            href: routeHref("runtime"),
            detail: "Current Host is not attached to a local project context.",
            severity: "info" as const,
          },
        ]
      : []) as Array<{
      label: string;
      href: string;
      detail: string;
      severity: "warning" | "info";
    }>),
    ...attention.map((item) => ({
      label: item.label,
      href: routeHref("overview"),
      detail: item.kind ?? "Operator action requires review.",
      severity: item.severity === "warning" ? ("warning" as const) : ("info" as const),
    })),
  ];
  if (loading && !data.summary) return <DashboardLoadingState title="Overview" />;
  return (
    <PageFrame title="Overview" description="Current Host state and operator attention queue.">
      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <h2 className="text-base font-medium leading-snug">Operator attention</h2>
              <CardDescription className="max-w-2xl text-pretty">
                {attentionItems.length
                  ? "Highest-priority operator checks and review queues for this host."
                  : "No urgent operator actions. Review queues below are healthy or informational."}
              </CardDescription>
            </div>
            <Badge variant={attentionItems.length ? "destructive" : "secondary"}>
              {attentionItems.length ? `${attentionItems.length} review items` : "All clear"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          {attentionItems.length ? (
            attentionItems.map((item) => (
              <a
                key={`${item.href}-${item.label}`}
                href={item.href}
                className="flex min-h-11 flex-col gap-1 rounded-lg border bg-background px-3 py-3 text-left transition-colors hover:bg-muted/60"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{item.label}</span>
                  <Badge variant={item.severity === "warning" ? "destructive" : "outline"}>
                    {item.severity === "warning" ? "Needs review" : "Inspect"}
                  </Badge>
                </div>
                <span className="text-sm text-muted-foreground">{item.detail}</span>
              </a>
            ))
          ) : (
            <EmptyLine text="No urgent operator actions." />
          )}
        </CardContent>
      </Card>
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric title="Caplets" value={String(inventoryCount)} />
        <Metric title="Clients" value={String((data.clients?.clients ?? []).length)} />
        <Metric title="Vault values" value={String((data.vault?.values ?? []).length)} />
      </div>
      <section className="grid gap-3 lg:grid-cols-3" aria-label="Operator triage">
        <TriageCard
          title="Pending approvals"
          status={pendingCount ? `${pendingCount} waiting` : "Clear"}
          detail="Approve, deny, or downgrade browser and client requests."
          href={routeHref("access")}
          actionLabel="Open approvals"
          severity={pendingCount ? "warning" : "ok"}
        />
        <TriageCard
          title="Catalog updates"
          status={updateSummary.label}
          detail="Review install readiness and update risk changes."
          href={routeHref("catalog")}
          actionLabel="Review update risk"
          severity={updateSummary.severity}
        />
        <TriageCard
          title="Project Binding"
          status={projectBindingState}
          detail="Check whether local project context is attached."
          href={routeHref("runtime")}
          actionLabel="Inspect binding"
          severity={projectBindingConnected ? "ok" : "info"}
        />
        <TriageCard
          title="Runtime health"
          status={runtimeStatus}
          detail="Review diagnostics and restart controls."
          href={routeHref("runtime")}
          actionLabel="Open runtime"
          severity={runtimeStatus === "ok" || runtimeStatus === "healthy" ? "ok" : "warning"}
        />
        <TriageCard
          title="Vault grants"
          status={`${vaultGrantCount} grants`}
          detail="Inspect stored values and grant metadata before installs."
          href={routeHref("vault")}
          actionLabel="Inspect grants"
          severity={vaultGrantCount ? "info" : "ok"}
        />
        <TriageCard
          title="Installed Caplets"
          status={`${inventoryCount} installed`}
          detail="Review update actions and Caplet metadata."
          href={routeHref("caplets")}
          actionLabel="Manage caplets"
          severity="info"
        />
      </section>
    </PageFrame>
  );
}

function TriageCard({
  title,
  status,
  detail,
  href,
  actionLabel,
  severity,
}: {
  title: string;
  status: string;
  detail: string;
  href: string;
  actionLabel: string;
  severity: "ok" | "info" | "warning";
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>{title}</CardTitle>
          <Badge
            variant={
              severity === "warning" ? "destructive" : severity === "ok" ? "secondary" : "outline"
            }
          >
            {status}
          </Badge>
        </div>
        <CardDescription>{detail}</CardDescription>
      </CardHeader>
      <CardContent>
        <a
          href={href}
          aria-label={actionLabel}
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-input px-3 text-sm font-medium hover:bg-accent md:h-11 md:min-h-11"
        >
          {actionLabel}
        </a>
      </CardContent>
    </Card>
  );
}

function catalogUpdateSummary(updates: Array<{ id?: string; status?: string; risk?: unknown }>) {
  if (!updates.length) return { label: "No updates", severity: "ok" as const };
  const riskyCount = updates.filter((update) => update.risk !== undefined).length;
  return {
    label: riskyCount
      ? `${updates.length} updates · risk review required`
      : `${updates.length} updates`,
    severity: "warning" as const,
  };
}

function AccessPage({
  data,
  loading,
  action,
  onLoadMore,
}: {
  data: DashboardData;
  loading: boolean;
  action: DashboardAction;
  onLoadMore: (key: DashboardCollectionKey) => Promise<void>;
}) {
  const { confirmAction, confirmTyped } = useActionConfirm();
  const pending = data.pending?.pendingLogins ?? [];
  const clients = data.clients?.clients ?? [];
  if (loading && !data.clients && !data.pending) return <DashboardLoadingState title="Access" />;
  return (
    <PageFrame
      title="Access"
      description="Approve browser and client requests, then manage the remote clients that keep dashboard or access credentials."
    >
      <section
        className="flex flex-wrap gap-2 rounded-lg border bg-secondary p-3 text-sm"
        role="note"
      >
        <strong>Role guide.</strong>
        <span className="text-muted-foreground">
          Operator clients can administer the dashboard. Access clients get limited runtime
          credentials without host administration.
        </span>
      </section>
      <Card>
        <CardHeader>
          <h2 className="text-base font-medium leading-snug">Pending logins</h2>
          <CardDescription>
            Requests from remote browsers and clients appear here for approval.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {pending.length ? (
            pending.map((login) => (
              <Row
                key={login.flowId}
                title={login.clientLabel || login.flowId}
                detail={`${login.requestedRole} · ${login.status}`}
                actions={
                  <>
                    <Button
                      size="sm"
                      aria-label={`Approve ${login.clientLabel || login.flowId} as operator`}
                      onClick={async () => {
                        if (
                          !(await confirmAction(
                            "Approve operator login?",
                            `${login.clientLabel || login.flowId} will receive dashboard administration access.`,
                          ))
                        )
                          return;
                        const intent = createDashboardMutationIntent();
                        await action("Approved operator login", async () => {
                          const detail = await adminV2GetRemoteLoginRequest(login.flowId);
                          return adminV2UpdateRemoteLoginRequest(
                            login.flowId,
                            { action: "approve", grantedRole: "operator" },
                            detail.etag,
                            intent,
                          );
                        });
                      }}
                    >
                      Approve operator
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Approve ${login.clientLabel || login.flowId} as access-only`}
                      onClick={async () => {
                        if (
                          !(await confirmAction(
                            "Approve access login?",
                            `${login.clientLabel || login.flowId} will receive access-only credentials.`,
                          ))
                        )
                          return;
                        const intent = createDashboardMutationIntent();
                        await action("Approved access login", async () => {
                          const detail = await adminV2GetRemoteLoginRequest(login.flowId);
                          return adminV2UpdateRemoteLoginRequest(
                            login.flowId,
                            { action: "approve", grantedRole: "access" },
                            detail.etag,
                            intent,
                          );
                        });
                      }}
                    >
                      Approve access
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      aria-label={`Deny pending login ${login.flowId}`}
                      onClick={async () => {
                        if (
                          !(await confirmAction(
                            "Deny pending login?",
                            `${login.clientLabel || login.flowId} will not receive credentials.`,
                          ))
                        )
                          return;
                        const intent = createDashboardMutationIntent();
                        await action("Denied login", async () => {
                          const detail = await adminV2GetRemoteLoginRequest(login.flowId);
                          return adminV2UpdateRemoteLoginRequest(
                            login.flowId,
                            { action: "deny" },
                            detail.etag,
                            intent,
                          );
                        });
                      }}
                    >
                      Deny
                    </Button>
                  </>
                }
              />
            ))
          ) : (
            <EmptyLine text="No pending logins. New requests will appear here so you can approve as Operator, grant Access-only credentials, or deny unknown clients." />
          )}
          <DashboardCollectionFooter
            count={pending.length}
            label="pending logins"
            progress={data.pending?.error ? undefined : data.pending}
            onLoadMore={() => void onLoadMore("pending")}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 id="access-clients-heading" className="text-base font-medium leading-snug">
            Clients
          </h2>
          <CardDescription>
            Approved remote clients and their current role assignments.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-3 md:hidden">
            {clients.length ? (
              clients.map((client) => (
                <ClientCard
                  key={client.clientId}
                  client={client}
                  action={action}
                  confirmAction={confirmAction}
                  confirmTyped={confirmTyped}
                />
              ))
            ) : (
              <EmptyLine text="No approved clients yet. Approve a pending login above to create the first remote client." />
            )}
          </div>
          <div className="hidden md:block">
            {clients.length ? (
              <Table aria-labelledby="access-clients-heading">
                <TableCaption>Approved remote clients</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Client</TableHead>
                    <TableHead scope="col">Role</TableHead>
                    <TableHead scope="col" className="text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clients.map((client) => (
                    <TableRow key={client.clientId}>
                      <TableCell>{client.clientLabel || client.clientId}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{client.role}</Badge>
                      </TableCell>
                      <TableCell className="flex justify-end gap-2">
                        <ClientActions
                          client={client}
                          action={action}
                          confirmAction={confirmAction}
                          confirmTyped={confirmTyped}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyLine text="No approved clients yet. Approve a pending login above to create the first remote client." />
            )}
          </div>
          <DashboardCollectionFooter
            count={clients.length}
            label="clients"
            progress={data.clients?.error ? undefined : data.clients}
            onLoadMore={() => void onLoadMore("clients")}
          />
        </CardContent>
      </Card>
    </PageFrame>
  );
}

function ClientCard({
  client,
  action,
  confirmAction,
  confirmTyped,
}: {
  client: Record<string, string>;
  action: DashboardAction;
  confirmAction: (title: string, description: string) => Promise<boolean>;
  confirmTyped: (title: string, description: string, expectedPhrase: string) => Promise<boolean>;
}) {
  return (
    <article className="grid gap-3 rounded-lg border bg-background p-3">
      <div>
        <h3 className="font-medium">{client.clientLabel || client.clientId}</h3>
        <Badge variant="secondary">{client.role}</Badge>
      </div>
      <div className="flex flex-wrap gap-2">
        <ClientActions
          client={client}
          action={action}
          confirmAction={confirmAction}
          confirmTyped={confirmTyped}
        />
      </div>
    </article>
  );
}

function ClientActions({
  client,
  action,
  confirmAction,
  confirmTyped,
}: {
  client: Record<string, string>;
  action: DashboardAction;
  confirmAction: (title: string, description: string) => Promise<boolean>;
  confirmTyped: (title: string, description: string, expectedPhrase: string) => Promise<boolean>;
}) {
  const label = client.clientLabel || client.clientId;
  const nextRole = client.role === "operator" ? "access" : "operator";
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        aria-label={`Change ${label} to ${nextRole} role`}
        onClick={async () => {
          if (!(await confirmAction("Change client role?", `${label} will become ${nextRole}.`)))
            return;
          const intent = createDashboardMutationIntent();
          await action("Role changed", async () => {
            const detail = await adminV2GetRemoteClient(client.clientId);
            return adminV2UpdateRemoteClient(
              client.clientId,
              { role: nextRole },
              detail.etag,
              intent,
            );
          });
        }}
      >
        Change to {nextRole}
      </Button>
      <Button
        size="sm"
        variant="destructive"
        aria-label={`Revoke ${label}`}
        onClick={async () => {
          if (
            !(await confirmTyped(
              "Revoke client?",
              `${label} will lose access immediately.`,
              `revoke ${client.clientId}`,
            ))
          )
            return;
          const intent = createDashboardMutationIntent();
          await action(
            "Client revoked",
            async () => {
              const detail = await adminV2GetRemoteClient(client.clientId);
              return adminV2DeleteRemoteClient(client.clientId, detail.etag, intent);
            },
            { clientRevocation: true },
          );
        }}
      >
        Revoke
      </Button>
    </>
  );
}

function CapletsPage({
  data,
  loading,
  action,
  onLoadMore,
}: {
  data: DashboardData;
  loading: boolean;
  action: DashboardAction;
  onLoadMore: (key: DashboardCollectionKey) => Promise<void>;
}) {
  const { confirmTyped } = useActionConfirm();
  const caplets = data.caplets?.caplets ?? [];
  const updateRisks = new Map(
    (data.updates?.updates ?? []).map((update) => [String(update.id), update]),
  );
  if (loading && !data.caplets) return <DashboardLoadingState title="Caplets" />;
  return (
    <PageFrame title="Caplets" description="Installed Caplets on this host.">
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-2">
            {caplets.length ? (
              caplets.map((caplet) => {
                const capletId = caplet.id ?? caplet.name ?? "caplet";
                const update = updateRisks.get(String(capletId));
                return (
                  <Row
                    key={capletId}
                    title={capletId}
                    detail={<CapletUpdateReadiness caplet={caplet} update={update} />}
                    actions={
                      update ? (
                        <TooltipIconButton
                          size="icon-sm"
                          variant="outline"
                          label={`Review update for ${capletId}`}
                          onClick={async () => {
                            if (
                              !(await confirmTyped(
                                "Review Caplet update?",
                                capletUpdateReviewSummary(caplet, update),
                                `update ${capletId}`,
                              ))
                            )
                              return;
                            const intent = createDashboardMutationIntent();
                            await action(catalogMutationLabel, () =>
                              adminV2UpdateCatalogCaplets(
                                {
                                  capletIds: [capletId],
                                  acknowledgeRiskIncrease: true,
                                },
                                intent,
                              ),
                            );
                          }}
                        >
                          <RefreshCwIcon />
                        </TooltipIconButton>
                      ) : (
                        <TooltipIconBadge
                          label={`No update available for ${capletId}`}
                          variant="secondary"
                        >
                          <CheckIcon />
                        </TooltipIconBadge>
                      )
                    }
                  />
                );
              })
            ) : (
              <EmptyLine text="No Caplets are installed." />
            )}
          </div>
          <DashboardCollectionFooter
            count={caplets.length}
            label="effective Caplets"
            progress={data.caplets?.error ? undefined : data.caplets}
            onLoadMore={() => void onLoadMore("caplets")}
          />
          <DashboardCollectionFooter
            count={data.updates?.updates?.length ?? 0}
            label="update candidates"
            progress={data.updates?.error ? undefined : data.updates}
            onLoadMore={() => void onLoadMore("updates")}
          />
        </CardContent>
      </Card>
    </PageFrame>
  );
}

function CapletUpdateReadiness({
  caplet,
  update,
}: {
  caplet: CapletRecord;
  update?: { id?: string; status?: string; risk?: unknown };
}) {
  const capletName = caplet.id ?? caplet.name ?? "caplet";
  const sourceLabel = caplet.source ? `Source ${caplet.source}` : "Source local/config";
  const lockLabel = caplet.updateState ? `Lock ${caplet.updateState}` : "Lock unknown";
  const authRequired = dashboardBoolean(caplet.authRequired);
  const setupRequired = dashboardBoolean(caplet.setupRequired);
  const projectBindingRequired = dashboardBoolean(caplet.projectBindingRequired);
  const authLabel = authRequired ? "Auth required" : "No auth required";
  const setupLabel = setupRequired ? "Setup required" : "No setup required";
  const bindingLabel = projectBindingRequired
    ? "Project Binding required"
    : "No Project Binding required";
  const updateLabel = update ? `Update ${update.status ?? "available"}` : "No update available";
  const riskSummary = riskSummaryLines(update?.risk);
  return (
    <div className="grid gap-2 text-sm">
      <p>{caplet.title ?? caplet.description ?? caplet.kind}</p>
      <div className="flex flex-wrap gap-1.5" aria-label="Caplet readiness summary">
        <TooltipIconBadge label={sourceLabel} variant="secondary">
          <DatabaseIcon />
        </TooltipIconBadge>
        <TooltipIconBadge label={lockLabel} variant="secondary">
          <ShieldCheckIcon />
        </TooltipIconBadge>
        <TooltipIconBadge label={authLabel} variant={authRequired ? "outline" : "secondary"}>
          <KeyIcon />
        </TooltipIconBadge>
        <TooltipIconBadge label={setupLabel} variant={setupRequired ? "outline" : "secondary"}>
          <SettingsIcon />
        </TooltipIconBadge>
        <TooltipIconBadge
          label={bindingLabel}
          variant={projectBindingRequired ? "outline" : "secondary"}
        >
          <LinkIcon />
        </TooltipIconBadge>
        <TooltipIconBadge label={updateLabel} variant={update ? "destructive" : "secondary"}>
          {update ? <RefreshCwIcon /> : <CheckIcon />}
        </TooltipIconBadge>
        {riskSummary.summary ? (
          <TooltipIconBadge
            label={`Update risk summary for ${capletName}: ${riskSummary.summary}`}
            variant="outline"
          >
            <AlertTriangleIcon />
          </TooltipIconBadge>
        ) : null}
      </div>
    </div>
  );
}

function capletUpdateReviewSummary(
  caplet: CapletRecord,
  update: { id?: string; status?: string; risk?: unknown },
): string {
  const riskSummary = riskSummaryLines(update.risk);
  const capletId = caplet.id ?? caplet.name ?? "caplet";
  const source = caplet.source ?? "local/config";
  const updateState = caplet.updateState ?? "unknown";
  const readiness = `${dashboardBoolean(caplet.authRequired) ? "auth required" : "no auth"}, ${dashboardBoolean(caplet.setupRequired) ? "setup required" : "no setup"}, ${dashboardBoolean(caplet.projectBindingRequired) ? "Project Binding required" : "no Project Binding requirement"}`;
  return [
    `${capletId} has an installable update review.`,
    `Source: ${source}.`,
    `Lock state: ${updateState}.`,
    `Readiness: ${readiness}.`,
    `Update state: ${update.status ?? "available"}.`,
    riskSummary.summary
      ? `Risk summary: ${riskSummary.summary}.`
      : "Risk summary: no elevated risk reported.",
    riskSummary.details.length ? `Risk details: ${riskSummary.details.join("; ")}.` : "",
    "Type the exact Caplet id only after reviewing this update metadata.",
  ]
    .filter(Boolean)
    .join(" ");
}

function riskSummaryLines(risk: unknown): { summary?: string; details: string[] } {
  if (!risk || typeof risk !== "object") {
    return typeof risk === "string" ? { summary: risk, details: [] } : { details: [] };
  }
  const record = risk as Record<string, unknown>;
  const details: string[] = [];
  if (Array.isArray(record.backendFamilies) && record.backendFamilies.length) {
    details.push(`Backends ${record.backendFamilies.join(", ")}`);
  }
  if (typeof record.safety === "string")
    details.push(`Safety ${record.safety.replace(/_/gu, " ")}`);
  if (typeof record.mutating === "boolean")
    details.push(record.mutating ? "Mutates external state" : "Read-focused");
  if (typeof record.destructive === "boolean" && record.destructive)
    details.push("Destructive behavior possible");
  if (typeof record.projectBindingRequired === "boolean" && record.projectBindingRequired) {
    details.push("Project Binding required");
  }
  if (typeof record.bodyHash === "string")
    details.push(`Manifest hash ${record.bodyHash.slice(0, 18)}…`);
  return {
    summary: details.length ? details.slice(0, 2).join(" · ") : "Review update details",
    details,
  };
}

function RecordRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <dt className="font-mono text-xs font-bold text-muted-foreground">{label}</dt>
      <dd className="m-0 break-words [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function vaultKeyPresentation(rawKey: string): { label: string; kind: string; sensitive: boolean } {
  const upper = rawKey.toUpperCase();
  const sensitive = /(TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY|CLIENT_SECRET)/u.test(upper);
  const kind = /(PATH|DIR|ROOT|FILE)/u.test(upper)
    ? "Local path"
    : sensitive
      ? "Credential"
      : "Stored value";
  if (!sensitive) return { label: rawKey, kind, sensitive };
  const masked = rawKey.replace(/(TOKEN|SECRET|PASSWORD|KEY)$/iu, "••••");
  return {
    label: masked === rawKey ? `${rawKey.slice(0, Math.min(rawKey.length, 14))}••••` : masked,
    kind,
    sensitive,
  };
}

function VaultPage({
  data,
  loading,
  action,
  onLoadMore,
}: {
  data: DashboardData;
  loading: boolean;
  action: (label: string, callback: () => Promise<unknown>) => Promise<void>;
  onLoadMore: (key: DashboardCollectionKey) => Promise<void>;
}) {
  const confirm = useConfirm();
  const dismissConfirmation = useDismissConfirmation();
  const { confirmTyped } = useActionConfirm();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const grants = data.vault?.grants ?? [];
  const [revealed, setRevealed] = useState<{ key: string; value: string; expiresAt: number }>();
  const [now, setNow] = useState(Date.now());
  const values = data.vault?.values ?? [];
  const isMounted = useRef(true);
  const revealGeneration = useRef(0);
  const [expiry] = useState(() => createEphemeralRevealExpiry(() => setRevealed(undefined)));
  function clearRevealed() {
    revealGeneration.current += 1;
    expiry.cancel();
    setRevealed(undefined);
  }
  useEffect(() => {
    isMounted.current = true;
    return () => {
      dismissConfirmation();
      isMounted.current = false;
      revealGeneration.current += 1;
      expiry.cancel();
    };
  }, [dismissConfirmation, expiry]);
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [revealed]);
  async function setVaultValue() {
    if (!key || !value) return;
    const replacing = values.some((entry) => String(entry.key) === key);
    if (
      replacing &&
      !(await confirmTyped(
        "Replace existing Vault value?",
        `${key} already exists. Replacing it overwrites the stored secret value.`,
        `replace ${key}`,
      ))
    )
      return;
    const intent = createDashboardMutationIntent();
    await action(replacing ? "Vault value replaced" : "Vault value saved", async () => {
      const etag = replacing ? (await adminV2GetVaultValue(key)).etag : "*";
      return adminV2PutVaultValue(key, { value }, etag, intent);
    });
  }
  if (loading && !data.vault) return <DashboardLoadingState title="Vault" />;
  return (
    <PageFrame
      title="Vault"
      description="Manage stored values without exposing secrets by default."
    >
      <Card>
        <CardHeader>
          <h2 className="text-base font-medium leading-snug">Set value</h2>
          <CardDescription>
            Store or replace one value at a time for the Current Host.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void setVaultValue();
            }}
          >
            <label className="grid gap-1.5 text-sm">
              <span className="font-mono text-xs font-bold text-muted-foreground">Key</span>
              <Input
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="service.token"
                autoComplete="off"
                required
                aria-describedby="vault-form-help"
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-mono text-xs font-bold text-muted-foreground">Value</span>
              <Input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Secret value"
                type="password"
                autoComplete="off"
                required
              />
            </label>
            <Button type="submit" disabled={!key || !value} aria-label="Set Vault value">
              {values.some((entry) => String(entry.key) === key) ? "Replace value" : "Set"}
            </Button>
            <p id="vault-form-help" className="text-sm text-muted-foreground md:col-span-3">
              Press Enter to save. Existing values are overwritten only after this form submits.
            </p>
          </form>
        </CardContent>
      </Card>
      {revealed ? (
        <SecretRevealPanel
          secret={revealed}
          secondsRemaining={Math.max(0, Math.ceil((revealed.expiresAt - now) / 1000))}
          onHide={clearRevealed}
        />
      ) : null}
      <Card>
        <CardHeader>
          <h2 className="text-base font-medium leading-snug">Values</h2>
          <CardDescription>
            Credential names are softened until you deliberately inspect or reveal them.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {values.length ? (
            values.map((entry) => {
              const rawKey = String(entry.key);
              const presentation = vaultKeyPresentation(rawKey);
              return (
                <Row
                  key={rawKey}
                  title={
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono">{presentation.label}</span>
                      <Badge variant={presentation.sensitive ? "outline" : "secondary"}>
                        {presentation.kind}
                      </Badge>
                    </div>
                  }
                  detail={
                    presentation.sensitive
                      ? `${entry.valueBytes ?? 0} bytes · full key hidden until explicit reveal`
                      : `${entry.valueBytes ?? 0} bytes`
                  }
                  actions={
                    <>
                      <TooltipIconButton
                        size="icon-sm"
                        variant="outline"
                        label={`Reveal vault value ${rawKey}`}
                        onClick={async () => {
                          const confirmation = await confirm({
                            title: "Reveal secret value?",
                            description: `${rawKey} will be visible in a dedicated panel for ${REVEAL_DURATION_SECONDS} seconds in this browser session only.`,
                            expectedPhrase: `reveal ${rawKey}`,
                            confirmLabel: `Reveal for ${REVEAL_DURATION_SECONDS}s`,
                            destructive: true,
                          });
                          if (!isMounted.current || confirmation !== `reveal ${rawKey}`) return;
                          const requestGeneration = ++revealGeneration.current;
                          await action("Vault value revealed", async () => {
                            let revealed: { value: string };
                            try {
                              revealed = await revealVaultValue(rawKey, confirmation);
                            } catch (error) {
                              if (
                                !isMounted.current ||
                                requestGeneration !== revealGeneration.current
                              )
                                return ACTION_DISCARDED;
                              throw error;
                            }
                            if (
                              !isMounted.current ||
                              requestGeneration !== revealGeneration.current
                            )
                              return ACTION_DISCARDED;
                            const revealedAt = Date.now();
                            setNow(revealedAt);
                            setRevealed({
                              key: rawKey,
                              value: revealed.value,
                              expiresAt: revealedAt + EPHEMERAL_REVEAL_TTL_MS,
                            });
                            expiry.replace();
                          });
                        }}
                      >
                        <EyeIcon />
                      </TooltipIconButton>
                      <TooltipIconButton
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        label={`Delete vault value ${rawKey}`}
                        onClick={async () => {
                          if (
                            !(await confirmTyped(
                              "Delete Vault value?",
                              `${rawKey} cannot be recovered from the dashboard after deletion.`,
                              `delete ${rawKey}`,
                            ))
                          )
                            return;
                          const intent = createDashboardMutationIntent();
                          await action("Vault value deleted", async () => {
                            const detail = await adminV2GetVaultValue(rawKey);
                            return adminV2DeleteVaultValue(rawKey, detail.etag, intent);
                          });
                        }}
                      >
                        <Trash2Icon />
                      </TooltipIconButton>
                    </>
                  }
                />
              );
            })
          ) : (
            <EmptyLine text="No Vault values." />
          )}
          <DashboardCollectionFooter
            count={values.length}
            label="Vault values"
            progress={
              data.vault?.error
                ? undefined
                : {
                    nextCursor: data.vault?.valuesNextCursor,
                    loadingMore: data.vault?.valuesLoadingMore,
                    paginationError: data.vault?.valuesPaginationError,
                  }
            }
            onLoadMore={() => void onLoadMore("vaultValues")}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 className="text-base font-medium leading-snug">Access grants</h2>
          <CardDescription>
            Caplet references that can resolve stored Vault values without revealing their contents.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {grants.length ? (
            grants.map((grant, index) => {
              const storedKey = String(grant.storedKey ?? "Unknown value");
              const capletId = String(grant.capletId ?? "Unknown Caplet");
              const referenceName = String(grant.referenceName ?? storedKey);
              const origin =
                grant.origin && typeof grant.origin === "object"
                  ? String(Reflect.get(grant.origin, "kind") ?? "unknown origin")
                  : "unknown origin";
              const storedValue = vaultKeyPresentation(storedKey);
              return (
                <Row
                  key={`${capletId}:${referenceName}:${storedKey}:${index}`}
                  title={
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{capletId}</span>
                      <Badge variant="outline">{origin}</Badge>
                    </div>
                  }
                  detail={`${referenceName} resolves ${storedValue.label}`}
                />
              );
            })
          ) : (
            <EmptyLine text="No Vault access grants." />
          )}
          <DashboardCollectionFooter
            count={grants.length}
            label="Vault grants"
            progress={
              data.vault?.error
                ? undefined
                : {
                    nextCursor: data.vault?.grantsNextCursor,
                    loadingMore: data.vault?.grantsLoadingMore,
                    paginationError: data.vault?.grantsPaginationError,
                  }
            }
            onLoadMore={() => void onLoadMore("vaultGrants")}
          />
        </CardContent>
      </Card>
    </PageFrame>
  );
}

function SecretRevealPanel({
  secret,
  secondsRemaining,
  onHide,
}: {
  secret: { key: string; value: string };
  secondsRemaining: number;
  onHide: () => void;
}) {
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>Secret reveal: {secret.key}</CardTitle>
        <CardDescription>
          Visible for {secondsRemaining} seconds. Hide it when you are done.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-primary p-3 text-primary-foreground">
          <code>{secret.value}</code>
        </pre>
        <div className="flex flex-wrap gap-2">
          <TooltipIconButton
            type="button"
            variant="outline"
            label={`Copy revealed value for ${secret.key}`}
            onClick={() => void copyToClipboard(secret.value, "Secret copied")}
          >
            <ClipboardListIcon />
          </TooltipIconButton>
          <TooltipIconButton
            type="button"
            variant="destructive"
            label="Hide revealed value"
            onClick={onHide}
          >
            <EyeOffIcon />
          </TooltipIconButton>
        </div>
      </CardContent>
    </Card>
  );
}

function humanizeToken(value: string): string {
  return value.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (char) => char.toUpperCase());
}

function formatDashboardTimestamp(value: unknown): { display: string; exact: string } {
  const exact = String(value ?? "");
  const parsed = Date.parse(exact);
  if (!exact || Number.isNaN(parsed)) return { display: exact || "Unknown", exact };
  return {
    display: new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(parsed)),
    exact,
  };
}

function activityEntryView(entry: Record<string, unknown>) {
  const target = (entry.target as Record<string, unknown> | undefined) ?? {};
  const timestamp = formatDashboardTimestamp(entry.createdAt);
  return {
    id: String(entry.id ?? ""),
    action: humanizeToken(String(entry.action ?? "Activity")),
    actionToken: String(entry.action ?? "activity"),
    actor: String(entry.actorClientId ?? "Unknown actor"),
    outcome: humanizeToken(String(entry.outcome ?? "unknown")),
    targetType: humanizeToken(String(target.type ?? "target")),
    targetId: String(target.id ?? "Unknown target"),
    timestamp,
  };
}

function RuntimePage({
  data,
  loading,
  restartPending,
  requestRestart,
}: {
  data: DashboardData;
  loading: boolean;
  restartPending: boolean;
  requestRestart: () => Promise<void>;
}) {
  const runtime = data.runtime?.runtime ?? {};
  const checks = data.diagnostics?.checks ?? [];
  const runtimeStatus = String(runtime.status ?? "unknown");
  const healthy = runtimeStatus === "ok" || runtimeStatus === "healthy";
  if (loading && !data.runtime) return <DashboardLoadingState title="Runtime" />;
  return (
    <PageFrame title="Runtime" description="Health, diagnostics, and daemon actions.">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-medium leading-snug">
                  {healthy ? "Runtime healthy" : "Runtime needs review"}
                </h2>
                <CardDescription role="status" aria-live="polite">
                  Runtime status: {humanizeToken(runtimeStatus)}.
                </CardDescription>
              </div>
              <Badge variant={healthy ? "secondary" : "destructive"}>
                {humanizeToken(runtimeStatus)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4">
            <dl className="grid gap-3 sm:grid-cols-2">
              <RecordRow label="Version" value={String(runtime.version ?? "Unknown")} />
              <RecordRow label="Bind address" value={String(runtime.bind ?? "Unknown")} />
            </dl>
            <Alert>
              <AlertTriangleIcon />
              <AlertTitle>Daemon actions can interrupt active work.</AlertTitle>
              <AlertDescription>
                Restarting the runtime interrupts active Current Host requests while the daemon
                restarts.
              </AlertDescription>
            </Alert>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                className="md:h-11 md:min-h-11"
                aria-label="Restart runtime"
                disabled={restartPending}
                aria-busy={restartPending}
                onClick={() => void requestRestart()}
              >
                {restartPending ? "Restart pending…" : "Restart runtime"}
              </Button>
              <a
                href={routeHref("activity")}
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-input px-3 text-sm font-medium hover:bg-accent md:h-11 md:min-h-11"
              >
                View activity log
              </a>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <h2 className="text-base font-medium leading-snug">Diagnostics</h2>
            <CardDescription>Runtime and dashboard checks for the Current Host.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {checks.length ? (
              checks.map((check) => (
                <Row
                  key={check.id}
                  title={
                    <div className="grid gap-0.5">
                      <span>{humanizeToken(String(check.id ?? "check"))}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {String(check.id ?? "check")}
                      </span>
                    </div>
                  }
                  detail={`Status: ${humanizeToken(String(check.status ?? "unknown"))}`}
                />
              ))
            ) : (
              <EmptyLine text="No diagnostics were reported." />
            )}
          </CardContent>
        </Card>
      </div>
    </PageFrame>
  );
}

function ActivityPage({ data, loading }: { data: DashboardData; loading: boolean }) {
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState("all");
  const entryViews = ((data.activity?.entries ?? []) as Array<Record<string, unknown>>).map(
    activityEntryView,
  );
  const filteredEntries = entryViews.filter((entry) => {
    const outcomeMatches = outcome === "all" || entry.outcome.toLowerCase() === outcome;
    const haystack = [entry.action, entry.actor, entry.targetType, entry.targetId, entry.id]
      .join(" ")
      .toLowerCase();
    return outcomeMatches && (!query || haystack.includes(query.toLowerCase()));
  });
  const filtersActive = query.trim().length > 0 || outcome !== "all";
  if (loading && !data.activity) return <DashboardLoadingState title="Activity" />;
  return (
    <PageFrame
      title="Activity"
      description="Operator events with secrets and payloads redacted; actor, target, outcome, and timestamp are retained."
    >
      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <h2 className="text-base font-medium leading-snug">Recent operator events</h2>
              <CardDescription className="max-w-2xl">
                Search or filter the audit log when you need to trace who changed what and when.
              </CardDescription>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem] lg:w-[28rem]">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                type="search"
                placeholder="Search actions, actors, or targets"
                aria-label="Search activity"
              />
              <Select
                value={outcome}
                onValueChange={(next) => next && setOutcome(next)}
                itemToStringLabel={activityOutcomeLabel}
              >
                <SelectTrigger aria-label="Outcome filter" className="h-10 w-full bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All outcomes</SelectItem>
                    <SelectItem value="success">Success</SelectItem>
                    <SelectItem value="failure">Failure</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          {data.activity?.error ? (
            <Alert variant="destructive" role="alert">
              <AlertTriangleIcon />
              <AlertTitle>Activity log unavailable</AlertTitle>
              <AlertDescription>{data.activity.error}</AlertDescription>
            </Alert>
          ) : filteredEntries.length ? (
            <>
              <div className="grid gap-3 md:hidden">
                {filteredEntries.map((entry) => (
                  <article
                    key={entry.id || `${entry.actionToken}-${entry.timestamp.exact}`}
                    className="grid gap-2 rounded-lg border bg-background p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-medium">{entry.action}</h3>
                      <Badge
                        variant={
                          entry.outcome.toLowerCase() === "success" ? "secondary" : "outline"
                        }
                      >
                        {entry.outcome}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">Actor: {entry.actor}</p>
                    <p className="text-sm text-muted-foreground">
                      Target: {entry.targetType} · {entry.targetId}
                    </p>
                    <p className="text-sm text-muted-foreground">Time: {entry.timestamp.display}</p>
                    <details className="text-sm text-muted-foreground">
                      <summary className="cursor-pointer font-medium text-foreground">
                        Details
                      </summary>
                      <div className="mt-2 grid gap-1">
                        <span className="font-mono text-xs">{entry.actionToken}</span>
                        <span className="font-mono text-xs">{entry.timestamp.exact}</span>
                        <span className="font-mono text-xs">{entry.id}</span>
                      </div>
                    </details>
                  </article>
                ))}
              </div>
              <div className="hidden md:block">
                <Table aria-label="Recent redacted operator activity">
                  <TableCaption>Recent redacted operator activity</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Action</TableHead>
                      <TableHead scope="col">Outcome</TableHead>
                      <TableHead scope="col">Actor</TableHead>
                      <TableHead scope="col">Target</TableHead>
                      <TableHead scope="col">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredEntries.map((entry) => (
                      <TableRow key={entry.id || `${entry.actionToken}-${entry.timestamp.exact}`}>
                        <TableCell>
                          <div className="grid gap-0.5">
                            <span>{entry.action}</span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {entry.actionToken}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>{entry.outcome}</TableCell>
                        <TableCell className="break-all whitespace-normal">{entry.actor}</TableCell>
                        <TableCell className="whitespace-normal">
                          {entry.targetType} · {entry.targetId}
                        </TableCell>
                        <TableCell>
                          <div className="grid gap-0.5">
                            <span>{entry.timestamp.display}</span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {entry.timestamp.exact}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : entryViews.length ? (
            <div className="grid gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground sm:flex sm:items-center sm:justify-between">
              <span>No activity matches the current search or outcome filter.</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={!filtersActive}
                onClick={() => {
                  setQuery("");
                  setOutcome("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <EmptyLine text="No activity recorded yet." />
          )}
        </CardContent>
      </Card>
    </PageFrame>
  );
}

function SettingsPage({ session, summary }: { session: DashboardSession; summary?: Summary }) {
  const isDevelopmentSession = session.operatorClientId === "development_unauthenticated";
  return (
    <PageFrame
      title="Settings"
      description="Inspect the current dashboard session, authentication mode, and host connection details."
    >
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-medium leading-snug">Dashboard session</h2>
              <CardDescription>
                {isDevelopmentSession
                  ? "Development no-auth mode is active for this browser session."
                  : "This browser is using an approved operator session."}
              </CardDescription>
            </div>
            <Badge variant={isDevelopmentSession ? "outline" : "secondary"}>
              {isDevelopmentSession ? "No-auth development bypass" : "Operator session"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Alert>
            <AlertTriangleIcon />
            <AlertTitle>
              {isDevelopmentSession
                ? "Operator checks are bypassed locally."
                : "Approved operator access."}
            </AlertTitle>
            <AlertDescription>
              {isDevelopmentSession
                ? "Requests still target the Current Host, but browser approval and logout enforcement are bypassed for local iteration."
                : "This browser can administer the Current Host until the session expires or is revoked."}
            </AlertDescription>
          </Alert>
          <dl className="grid gap-3 sm:grid-cols-2">
            <RecordRow
              label="Authentication mode"
              value={
                isDevelopmentSession ? "Development no-auth bypass" : "Approved operator session"
              }
            />
            <RecordRow label="Current Host" value={summary?.host?.baseUrl ?? "Current Host"} />
            <RecordRow label="Operator client ID" value={session.operatorClientId} />
            <RecordRow label="CSRF token" value={session.csrfToken} />
          </dl>
          <div className="flex flex-wrap gap-2">
            <TooltipIconButton
              variant="outline"
              size="icon"
              label="Copy operator client ID"
              onClick={() =>
                void copyToClipboard(session.operatorClientId, "Operator client ID copied")
              }
            >
              <ClipboardListIcon />
            </TooltipIconButton>
            {isDevelopmentSession ? (
              <Button variant="secondary" disabled aria-label="No logout in no-auth mode">
                No logout in no-auth mode
              </Button>
            ) : null}
          </div>
          {isDevelopmentSession ? (
            <p className="text-sm text-muted-foreground">
              Restart the server without no-auth mode to require browser approval again. Manage
              future client approvals from Access.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </PageFrame>
  );
}

function PageFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        <p className="text-muted-foreground text-pretty">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle>{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

function DashboardLoadingState({ title }: { title: string }) {
  return (
    <PageFrame title={title} description="Loading Current Host data…">
      <div className="grid gap-4 md:grid-cols-3" aria-label="Loading dashboard data">
        {[0, 1, 2].map((item) => (
          <Card key={item}>
            <CardHeader className="gap-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-16" />
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="grid gap-3 pt-6">
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-14 w-full" />
          ))}
        </CardContent>
      </Card>
    </PageFrame>
  );
}

function DashboardCollectionFooter({
  count,
  label,
  progress,
  onLoadMore,
}: {
  count: number;
  label: string;
  progress?: DashboardPageProgress;
  onLoadMore: () => void;
}) {
  if (!progress) return null;
  return (
    <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm text-muted-foreground" aria-live="polite">
        {count} {label} loaded
        {progress.paginationError ? (
          <p className="mt-1 text-destructive" role="alert">
            {progress.paginationError}
          </p>
        ) : null}
      </div>
      {progress.nextCursor || progress.paginationError ? (
        <Button
          type="button"
          variant="outline"
          disabled={progress.loadingMore}
          aria-busy={progress.loadingMore}
          onClick={onLoadMore}
        >
          <RefreshCwIcon
            data-icon="inline-start"
            className={progress.loadingMore ? "animate-spin motion-reduce:animate-none" : undefined}
          />
          Load more {label}
        </Button>
      ) : null}
    </div>
  );
}

function Row({
  title,
  detail,
  actions,
}: {
  title: React.ReactNode;
  detail?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 flex-1">
        <div className="break-words font-medium">{title}</div>
        {detail ? (
          <div className="min-w-0 break-words text-sm text-muted-foreground">{detail}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap gap-2 md:justify-end">{actions}</div>
      ) : null}
    </div>
  );
}

function activityOutcomeLabel(value: string): string {
  if (value === "all") return "All outcomes";
  return humanizeToken(value);
}

function EmptyLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
      <CheckIcon className="size-4" />
      {text}
    </div>
  );
}

export function routeFromPath(pathname: string): RouteKey {
  const basePath = dashboardBasePath(pathname);
  const normalizedPathname = pathname.replace(/\/+$/u, "");
  const relativePath = normalizedPathname.startsWith(basePath)
    ? normalizedPathname.slice(basePath.length)
    : normalizedPathname;
  const segment =
    relativePath
      .replace(/^\/+|\/+$/gu, "")
      .split("/")
      .shift() || "overview";
  return routes.some((route) => route.key === segment) ? (segment as RouteKey) : "overview";
}
