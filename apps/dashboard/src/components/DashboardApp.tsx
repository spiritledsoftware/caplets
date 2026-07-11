import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  ExternalLinkIcon,
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
  SearchIcon,
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
  dashboardApi,
  isDashboardUnauthorized,
  setDashboardSession,
  type DashboardSession,
} from "@/lib/api";
import { EPHEMERAL_REVEAL_TTL_MS, createEphemeralRevealExpiry } from "@/lib/ephemeral-reveal";
import { dashboardBasePath, dashboardPath } from "@/lib/paths";

const REVEAL_DURATION_SECONDS = EPHEMERAL_REVEAL_TTL_MS / 1_000;
const ACTION_DISCARDED = Symbol("dashboard-action-discarded");

type RouteKey =
  | "overview"
  | "access"
  | "caplets"
  | "catalog"
  | "vault"
  | "runtime"
  | "activity"
  | "settings";

type Summary = {
  host?: { baseUrl?: string; version?: string };
  attention?: Array<{ label: string; severity?: string; kind?: string }>;
  sections?: Record<string, unknown>;
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

type DashboardData = {
  summary?: Summary;
  caplets?: { caplets?: Array<CapletRecord>; error?: string };
  clients?: { clients?: Array<Record<string, string>>; error?: string };
  pending?: { pendingLogins?: Array<Record<string, string>>; error?: string };
  vault?: {
    values?: Array<Record<string, string | number>>;
    grants?: Array<Record<string, unknown>>;
    error?: string;
  };
  runtime?: { runtime?: Record<string, string>; daemon?: Record<string, unknown>; error?: string };
  diagnostics?: { status?: string; checks?: Array<Record<string, string>>; error?: string };
  activity?: { entries?: Array<Record<string, unknown>>; error?: string };
  logs?: { entries?: Array<Record<string, unknown>>; error?: string };
  projectBinding?: {
    projectBinding?: { state?: string; actions?: Array<Record<string, string | boolean>> };
    error?: string;
  };
  updates?: {
    ready?: boolean;
    reason?: string;
    updates?: Array<{ id?: string; status?: string; risk?: unknown }>;
    error?: string;
  };
};

const routes: Array<{
  key: RouteKey;
  label: string;
  href: string;
  icon: typeof HomeIcon;
}> = [
  { key: "overview", label: "Overview", href: dashboardPath(), icon: HomeIcon },
  { key: "access", label: "Access", href: dashboardPath("access"), icon: ShieldCheckIcon },
  { key: "caplets", label: "Caplets", href: dashboardPath("caplets"), icon: BoxesIcon },
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
  const confirmationRef = useRef<ConfirmationRequest | undefined>(undefined);

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

  useEffect(() => {
    let cancelled = false;
    void restoreDashboardSession(0, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  function endDashboardSession(message = "Authorization required.") {
    setSession(undefined);
    setDashboardSession(undefined);
    setData({});
    setAuthCommand("");
    setAuthMessage(message);
    setLoading(false);
    setDataLoading(false);
  }

  async function restoreDashboardSession(attempt: number, cancelled: () => boolean) {
    setLoading(true);
    try {
      const result = await dashboardApi<{ authenticated: boolean; session: DashboardSession }>(
        "session",
      );
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
        () => restoreDashboardSession(attempt + 1, cancelled),
        Math.min(10_000, 1_000 + attempt * 1_000),
      );
    }
  }

  async function refresh(): Promise<boolean> {
    setDataLoading(true);
    try {
      const loaded = await Promise.all([
        load("summary", "summary"),
        load("caplets", "caplets"),
        load("clients", "access/clients"),
        load("pending", "access/pending-logins"),
        load("vault", "vault"),
        load("runtime", "runtime"),
        load("diagnostics", "diagnostics"),
        load("activity", "activity?limit=50"),
        load("logs", "logs?limit=100"),
        load("projectBinding", "project-binding"),
        load("updates", "catalog/updates"),
      ]);
      setData(
        Object.fromEntries(loaded.map((entry) => [entry.name, entry.value])) as DashboardData,
      );
      return true;
    } catch (error) {
      if (isDashboardUnauthorized(error)) {
        endDashboardSession();
        return false;
      }
      throw error;
    } finally {
      setDataLoading(false);
    }
  }

  async function load(name: string, path: string) {
    try {
      return { name, value: await dashboardApi(path) };
    } catch (error) {
      if (isDashboardUnauthorized(error)) throw error;
      return { name, value: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  async function startAuthorization() {
    setLoading(true);
    try {
      const pending = await dashboardApi<{
        flowId: string;
        pendingCompletionSecret: string;
        intervalSeconds: number;
        approvalCommand: string;
      }>("login/start", {
        method: "POST",
        body: JSON.stringify({ clientLabel: "Browser Dashboard" }),
      });
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

  async function pollAuthorization(pending: {
    flowId: string;
    pendingCompletionSecret: string;
    intervalSeconds: number;
  }) {
    try {
      const result = await dashboardApi<{ status: string }>("login/poll", {
        method: "POST",
        body: JSON.stringify({
          flowId: pending.flowId,
          pendingCompletionSecret: pending.pendingCompletionSecret,
        }),
      });
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
      const completed = await dashboardApi<{ session: DashboardSession }>("login/complete", {
        method: "POST",
        body: JSON.stringify({
          flowId: pending.flowId,
          pendingCompletionSecret: pending.pendingCompletionSecret,
        }),
      });
      setSession(completed.session);
      setDashboardSession(completed.session);
      const refreshed = await refresh();
      if (refreshed) setLoading(false);
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : String(error));
      setLoading(false);
    }
  }

  async function action(label: string, callback: () => Promise<unknown>) {
    try {
      const result = await callback();
      if (result === ACTION_DISCARDED) return;
      const refreshed = await refresh();
      if (refreshed) toast.success(label);
    } catch (error) {
      if (isDashboardUnauthorized(error)) {
        endDashboardSession();
        return;
      }
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function logout() {
    try {
      await dashboardApi("logout", { method: "POST", body: "{}" });
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
  session,
}: {
  route: RouteKey;
  data: DashboardData;
  loading: boolean;
  session: DashboardSession;
  action: (label: string, callback: () => Promise<unknown>) => Promise<void>;
}) {
  if (route === "access") return <AccessPage data={data} loading={loading} action={action} />;
  if (route === "caplets") return <CapletsPage data={data} loading={loading} action={action} />;
  if (route === "catalog") return <CatalogPage data={data} action={action} />;
  if (route === "vault") return <VaultPage data={data} loading={loading} action={action} />;
  if (route === "runtime") return <RuntimePage data={data} loading={loading} action={action} />;
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
  const projectBindingState = data.projectBinding?.projectBinding?.state ?? "not configured";
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
    ...((projectBindingState !== "bound" && projectBindingState !== "ready"
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
          severity={projectBindingState === "bound" ? "ok" : "info"}
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
}: {
  data: DashboardData;
  loading: boolean;
  action: (label: string, callback: () => Promise<unknown>) => Promise<void>;
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
                        await action("Approved operator login", () =>
                          dashboardApi(`access/pending-logins/${login.flowId}/approve`, {
                            method: "POST",
                            body: JSON.stringify({ grantedRole: "operator" }),
                          }),
                        );
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
                        await action("Approved access login", () =>
                          dashboardApi(`access/pending-logins/${login.flowId}/approve`, {
                            method: "POST",
                            body: JSON.stringify({ grantedRole: "access" }),
                          }),
                        );
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
                        await action("Denied login", () =>
                          dashboardApi(`access/pending-logins/${login.flowId}/deny`, {
                            method: "POST",
                            body: "{}",
                          }),
                        );
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
  action: (label: string, callback: () => Promise<unknown>) => Promise<void>;
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
  action: (label: string, callback: () => Promise<unknown>) => Promise<void>;
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
          await action("Role changed", () =>
            dashboardApi(`access/clients/${client.clientId}/role`, {
              method: "POST",
              body: JSON.stringify({ role: nextRole }),
            }),
          );
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
          await action("Client revoked", () =>
            dashboardApi(`access/clients/${client.clientId}/revoke`, {
              method: "POST",
              body: "{}",
            }),
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
}: {
  data: DashboardData;
  loading: boolean;
  action: (label: string, callback: () => Promise<unknown>) => Promise<void>;
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
                            await action("Update requested", () =>
                              dashboardApi("catalog/update", {
                                method: "POST",
                                body: JSON.stringify({
                                  capletId,
                                  acknowledgeRiskIncrease: true,
                                }),
                              }),
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

type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  source?: { repository?: string };
  sourcePath?: string;
  trustLevel?: string;
  setupReadiness?: string;
  authReadiness?: string;
  projectBindingReadiness?: string;
  workflow?: { label?: string; kind?: string };
  installCommand?: { text?: string; copyable?: boolean };
  warnings?: Array<{ code?: string; label: string; message?: string; severity?: string }>;
  icon?: { type?: string; url?: string };
  contentMarkdown?: string;
  resolvedRevision?: string;
  indexedContentHash?: string;
};

type CatalogSearchResponse = { entries?: CatalogEntry[]; error?: string };
type CatalogDetailResponse = {
  entry?: CatalogEntry;
  setupActions?: Array<{ kind: string; label: string; required: boolean }>;
  error?: string;
};

const catalogSearchEndpoint = "catalog/search";
const catalogDetailEndpoint = "catalog/detail";
const catalogInstallEndpoint = "catalog/install";

function CatalogPage({
  data,
  action,
}: {
  data: DashboardData;
  action: (label: string, callback: () => Promise<unknown>) => Promise<void>;
}) {
  return <CatalogMirrorPage data={data} action={action} />;
}

function CatalogMirrorPage({
  data,
  action,
}: {
  data: DashboardData;
  action: (label: string, callback: () => Promise<unknown>) => Promise<void>;
}) {
  const { confirmTyped } = useActionConfirm();
  const [source, setSource] = useState("official");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [setup, setSetup] = useState("all");
  const [tag, setTag] = useState("all");
  const [sort, setSort] = useState("rank");
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [selected, setSelected] = useState<CatalogEntry>();
  const [detail, setDetail] = useState<CatalogDetailResponse>();
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ source, q: query, limit: "100" });
      dashboardApi<CatalogSearchResponse>(`${catalogSearchEndpoint}?${params}`)
        .then((result) => {
          if (cancelled) return;
          const nextEntries = result.entries ?? [];
          setEntries(nextEntries);
          setSelected((current) =>
            current && nextEntries.some((entry) => entry.id === current.id) ? current : undefined,
          );
          setError(undefined);
        })
        .catch((searchError) => {
          if (cancelled) return;
          setEntries([]);
          setSelected(undefined);
          setError(searchError instanceof Error ? searchError.message : String(searchError));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, query]);

  useEffect(() => {
    if (!selected) {
      setDetail(undefined);
      return;
    }
    const params = new URLSearchParams({ source, id: selected.id });
    dashboardApi<CatalogDetailResponse>(`${catalogDetailEndpoint}?${params}`)
      .then(setDetail)
      .catch((detailError) =>
        setDetail({
          error: detailError instanceof Error ? detailError.message : String(detailError),
        }),
      );
  }, [source, selected]);

  const tags = useMemo(
    () => [...new Set(entries.flatMap((entry) => entry.tags ?? []))].sort(),
    [entries],
  );
  const visibleEntries = useMemo(() => {
    const filtered = entries.filter((entry) => {
      const trustMatches = scope === "all" || entry.trustLevel === scope;
      const setupMatches = setup === "all" || entry.setupReadiness === setup;
      const tagMatches = tag === "all" || (entry.tags ?? []).includes(tag);
      return trustMatches && setupMatches && tagMatches;
    });
    return [...filtered].sort((left, right) =>
      sort === "name" ? left.name.localeCompare(right.name) : rankEntry(right) - rankEntry(left),
    );
  }, [entries, scope, setup, sort, tag]);

  async function install(entry: CatalogEntry) {
    const expected = `install ${entry.id}`;
    if (!(await confirmTyped("Install Caplet?", installReviewSummary(entry), expected))) {
      return;
    }
    setInstalling(entry.id);
    try {
      await action(`Installed ${entry.name}`, () =>
        dashboardApi(catalogInstallEndpoint, {
          method: "POST",
          body: JSON.stringify({ source, capletId: entry.id }),
        }),
      );
    } finally {
      setInstalling(undefined);
    }
  }

  return (
    <PageFrame
      title="Catalog"
      description="Search the same catalog surface as caplets.dev, then install directly from this operator console."
    >
      <section className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground md:flex-row md:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg border bg-primary text-primary-foreground">
            <BoxIcon aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold">Caplets Catalog</div>
            <div className="text-sm text-muted-foreground">
              {visibleEntries.length} Caplets · Install button actions replace install commands
            </div>
          </div>
        </div>
        <label className="grid min-w-48 gap-1 text-sm">
          <span className="font-mono text-xs font-bold text-muted-foreground">Source</span>
          <Input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            aria-label="Catalog source"
            placeholder="official"
          />
        </label>
      </section>

      <section
        className="flex flex-wrap gap-2 rounded-lg border bg-secondary p-3 text-sm"
        role="note"
      >
        <strong>Not security-reviewed.</strong>
        <span className="text-muted-foreground">Inspect Caplets before installing.</span>
      </section>

      <Card className="overflow-hidden">
        <CardHeader className="gap-3 border-b bg-card">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="min-w-0 flex-1">
              <CardTitle>Browse catalog</CardTitle>
              <CardDescription>
                Install readiness: {data.updates?.ready === false ? data.updates.reason : "ready"}
              </CardDescription>
            </div>
            <div className="relative min-w-0 lg:w-[28rem]">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                type="search"
                placeholder="Search Caplets"
                aria-label="Search Caplets"
              />
            </div>
          </div>
          <CatalogFilterBar
            scope={scope}
            setup={setup}
            tag={tag}
            sort={sort}
            tags={tags}
            onScopeChange={setScope}
            onSetupChange={setSetup}
            onTagChange={setTag}
            onSortChange={setSort}
          />
          <CatalogLegend />
        </CardHeader>
        <CardContent className="p-0">
          <div className="sr-only" role="status" aria-live="polite">
            {loading
              ? "Loading catalog results"
              : error
                ? "Catalog results failed to load"
                : `${visibleEntries.length} catalog results loaded`}
          </div>
          {error ? <CatalogError message={error} /> : null}
          {loading ? (
            <CatalogLoadingRows />
          ) : (
            <CatalogResultGrid
              rows={visibleEntries}
              selectedId={selected?.id}
              installing={installing}
              loading={loading}
              onSelect={(entry) => {
                setSelected(entry);
                window.setTimeout(() => {
                  const panel = document.getElementById("catalog-detail-panel");
                  panel?.scrollIntoView({ block: "start" });
                  if (panel instanceof HTMLElement) panel.focus();
                }, 0);
              }}
              onInstall={(entry) => {
                setSelected(entry);
                window.setTimeout(() => {
                  const panel = document.getElementById("catalog-detail-panel");
                  panel?.scrollIntoView({ block: "start" });
                  if (panel instanceof HTMLElement) panel.focus();
                }, 0);
              }}
            />
          )}
        </CardContent>
      </Card>

      <CatalogDetailPanel
        entry={detail?.entry ?? selected}
        error={detail?.error}
        setupActions={detail?.setupActions ?? []}
        installing={installing}
        onInstall={(entry) => void install(entry)}
      />
    </PageFrame>
  );
}

function CatalogFilterBar({
  scope,
  setup,
  tag,
  sort,
  tags,
  onScopeChange,
  onSetupChange,
  onTagChange,
  onSortChange,
}: {
  scope: string;
  setup: string;
  tag: string;
  sort: string;
  tags: string[];
  onScopeChange: (value: string) => void;
  onSetupChange: (value: string) => void;
  onTagChange: (value: string) => void;
  onSortChange: (value: string) => void;
}) {
  return (
    <section className="grid gap-2 md:grid-cols-4" aria-label="Catalog filters">
      <CatalogSelect
        label="Scope"
        value={scope}
        onValueChange={onScopeChange}
        items={["all", "official", "community"]}
      />
      <CatalogSelect
        label="Setup"
        value={setup}
        onValueChange={onSetupChange}
        items={["all", "ready", "required", "unknown"]}
      />
      <CatalogSelect label="Tag" value={tag} onValueChange={onTagChange} items={["all", ...tags]} />
      <CatalogSelect
        label="Sort"
        value={sort}
        onValueChange={onSortChange}
        items={["rank", "name"]}
      />
    </section>
  );
}

function CatalogSelect({
  label,
  value,
  items,
  onValueChange,
}: {
  label: string;
  value: string;
  items: string[];
  onValueChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="font-mono text-xs font-bold text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={(next) => next && onValueChange(next)}>
        <SelectTrigger aria-label={`${label} filter`} className="h-10 w-full bg-card">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item} value={item}>
                {catalogLabel(item)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
  );
}

function CatalogLegend() {
  const items = [
    { label: "Official", icon: ShieldCheckIcon },
    { label: "Community", icon: ComputerIcon },
    { label: "External changes", icon: ExternalLinkIcon },
    { label: "Auth", icon: KeyIcon },
    { label: "Setup", icon: SettingsIcon },
    { label: "Binding", icon: LinkIcon },
    { label: "Unknown readiness", icon: AlertTriangleIcon },
  ];
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Status legend">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Badge
            key={item.label}
            variant="outline"
            className="h-8 gap-1.5 bg-background font-mono text-[0.7rem]"
          >
            <Icon aria-hidden="true" />
            {item.label}
          </Badge>
        );
      })}
    </div>
  );
}

function CatalogResultGrid({
  rows,
  selectedId,
  installing,
  loading,
  onSelect,
  onInstall,
}: {
  rows: CatalogEntry[];
  selectedId?: string;
  installing?: string;
  loading: boolean;
  onSelect: (entry: CatalogEntry) => void;
  onInstall: (entry: CatalogEntry) => void;
}) {
  if (!rows.length) {
    return (
      <div className="m-3 rounded-lg border border-dashed bg-background p-6 text-center">
        <h2 className="text-lg font-semibold tracking-tight">No matching Caplets</h2>
        <p className="mx-auto mt-2 max-w-prose text-muted-foreground">
          Reset filters or search for the service, workflow, or setup requirement you need.
        </p>
      </div>
    );
  }

  return (
    <section aria-label="Catalog results" aria-busy={loading}>
      <div className="grid max-h-[70vh] gap-3 overflow-y-auto p-3 md:hidden">
        {rows.map((row) => (
          <article
            key={row.id}
            className="grid gap-3 rounded-lg border bg-background p-3 data-[active=true]:border-primary data-[active=true]:bg-secondary"
            data-active={selectedId === row.id}
          >
            <div className="flex min-w-0 gap-3">
              <CatalogIcon entry={row} />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  aria-controls="catalog-detail-panel"
                  aria-pressed={selectedId === row.id}
                  className="block min-h-11 min-w-11 max-w-full truncate py-2 pr-2 text-left font-semibold underline-offset-4 hover:text-primary hover:underline"
                  onClick={() => onSelect(row)}
                >
                  {row.name}
                </button>
                {selectedId === row.id ? (
                  <Badge variant="outline" className="mt-2 w-fit gap-1">
                    <CheckIcon aria-hidden="true" /> Selected
                  </Badge>
                ) : null}
                <div className="truncate text-xs text-muted-foreground">
                  {row.source?.repository ?? "local/source"}
                </div>
              </div>
            </div>
            <p className="line-clamp-3 text-sm text-muted-foreground">{row.description}</p>
            <div className="flex flex-wrap gap-1" aria-label="Status">
              <CatalogStatusBadges row={row} />
            </div>
            <Button
              className="w-full"
              onClick={() => onInstall(row)}
              disabled={installing === row.id}
              aria-label={`Review install readiness for ${row.name}`}
              title="Install button"
            >
              Review install
            </Button>
          </article>
        ))}
      </div>
      <div className="hidden max-h-[70vh] overflow-auto md:block">
        <div
          className="min-w-[880px]"
          role="table"
          aria-label="Catalog results"
          aria-rowcount={rows.length + 1}
        >
          <div
            className="grid grid-cols-[minmax(12rem,1.1fr)_minmax(16rem,1.7fr)_6rem_10rem_minmax(9rem,0.8fr)] gap-3 border-b bg-muted px-4 py-2 font-mono text-xs font-bold text-muted-foreground"
            role="row"
          >
            <span role="columnheader">Caplet</span>
            <span role="columnheader">Description</span>
            <span role="columnheader">Installs</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Install</span>
          </div>
          <div role="rowgroup">
            {rows.map((row) => (
              <article
                key={row.id}
                className="grid min-h-[72px] grid-cols-[minmax(12rem,1.1fr)_minmax(16rem,1.7fr)_6rem_10rem_minmax(9rem,0.8fr)] items-center gap-3 border-b px-4 py-3 transition-colors hover:bg-muted/70 motion-reduce:transition-none data-[active=true]:ring-2 data-[active=true]:ring-primary data-[active=true]:bg-secondary"
                data-active={selectedId === row.id}
                role="row"
              >
                <div className="flex min-w-0 items-center gap-3" role="cell">
                  <CatalogIcon entry={row} />
                  <div className="min-w-0">
                    <button
                      className="block min-h-11 min-w-11 max-w-full truncate py-2 pr-2 text-left font-semibold underline-offset-4 hover:text-primary hover:underline"
                      type="button"
                      aria-controls="catalog-detail-panel"
                      aria-pressed={selectedId === row.id}
                      onClick={() => onSelect(row)}
                    >
                      {row.name}
                    </button>
                    <div className="truncate text-xs text-muted-foreground">
                      {row.source?.repository ?? "local/source"}
                    </div>
                  </div>
                </div>
                <p className="line-clamp-2 min-w-0 text-sm text-muted-foreground" role="cell">
                  {row.description}
                </p>
                <div className="font-mono text-xs font-bold text-muted-foreground" role="cell">
                  {installCountDisplay(row)}
                </div>
                <div className="flex min-w-0 flex-wrap gap-1" role="cell" aria-label="Status">
                  <CatalogStatusBadges row={row} />
                </div>
                <div className="flex justify-end" role="cell">
                  <Button
                    size="sm"
                    onClick={() => onInstall(row)}
                    disabled={installing === row.id}
                    aria-label={`Review install readiness for ${row.name}`}
                    title="Install button"
                  >
                    Review install
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function CatalogStatusBadges({ row }: { row: CatalogEntry }) {
  return (
    <>
      <Badge variant={row.trustLevel === "official" ? "default" : "secondary"}>
        {row.trustLevel ?? "community"}
      </Badge>
      {(row.warnings ?? []).slice(0, 2).map((warning) => (
        <Badge
          key={`${row.id}-${warning.code ?? warning.label}`}
          variant={warning.severity === "danger" ? "destructive" : "outline"}
        >
          {warning.label}
        </Badge>
      ))}
    </>
  );
}

function CatalogReadinessReview({
  entry,
  setupActions,
}: {
  entry: CatalogEntry;
  setupActions: Array<{ kind: string; label: string; required: boolean }>;
}) {
  const checks = [
    { label: "Trust", value: entry.trustLevel ?? "community" },
    { label: "Auth", value: entry.authReadiness ?? "unknown" },
    { label: "Setup", value: entry.setupReadiness ?? "unknown" },
    { label: "Project Binding", value: entry.projectBindingReadiness ?? "unknown" },
  ];
  return (
    <section className="rounded-lg border bg-secondary p-3" aria-labelledby="readiness-heading">
      <h3 id="readiness-heading" className="font-medium">
        Installation readiness review
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        The install confirmation repeats the exact Caplet id after you inspect these trust and setup
        checks.
      </p>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        {checks.map((check) => (
          <div key={check.label} className="rounded-md bg-background p-2">
            <dt className="font-mono text-xs font-bold text-muted-foreground">{check.label}</dt>
            <dd>{check.value}</dd>
          </div>
        ))}
      </dl>
      {setupActions.length ? (
        <ul className="mt-3 grid gap-2 text-sm">
          {setupActions.map((setupAction) => (
            <li key={`${setupAction.kind}-${setupAction.label}`} className="flex gap-2">
              <Badge variant={setupAction.required ? "destructive" : "outline"}>
                {setupAction.required ? "Required" : "Optional"}
              </Badge>
              <span>{setupAction.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CatalogDetailPanel({
  entry,
  error,
  setupActions,
  installing,
  onInstall,
}: {
  entry?: CatalogEntry;
  error?: string;
  setupActions: Array<{ kind: string; label: string; required: boolean }>;
  installing?: string;
  onInstall: (entry: CatalogEntry) => void;
}) {
  if (error) return <CatalogError message={error} />;
  if (!entry) {
    return (
      <Card>
        <CardContent className="grid gap-3 pt-6">
          <h2 className="text-base font-medium leading-snug">Inspect a Caplet</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Select a result to review trust, setup requirements, and manifest details before you
            install it.
          </p>
        </CardContent>
      </Card>
    );
  }
  const markdown = trimFrontmatter(entry.contentMarkdown ?? "");
  return (
    <section
      id="catalog-detail-panel"
      tabIndex={-1}
      className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_330px]"
      aria-label="Catalog detail"
    >
      <Card>
        <CardHeader className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div className="flex min-w-0 gap-4">
            <CatalogIcon entry={entry} large />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant={entry.trustLevel === "official" ? "default" : "secondary"}>
                  {entry.trustLevel ?? "community"}
                </Badge>
                <span>{entry.source?.repository ?? "local/source"}</span>
              </div>
              <h2 className="mt-2 text-3xl font-medium tracking-tight">{entry.name}</h2>
              <CardDescription className="mt-2 max-w-[68ch]">{entry.description}</CardDescription>
            </div>
          </div>
          <Button
            onClick={() => onInstall(entry)}
            disabled={installing === entry.id}
            aria-label={`Install button for ${entry.name}`}
          >
            Install
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <CatalogReadinessReview entry={entry} setupActions={setupActions} />
          <SafetyWarnings warnings={entry.warnings ?? []} />
          <details className="rounded-lg border bg-background p-4">
            <summary className="cursor-pointer font-mono text-xs font-bold text-muted-foreground">
              CAPLET.md
            </summary>
            {markdown ? (
              <pre className="mt-3 max-h-[32rem] overflow-auto rounded-lg bg-primary p-4 text-xs text-primary-foreground sm:text-sm">
                <code>{markdown}</code>
              </pre>
            ) : (
              <div className="mt-3">
                <EmptyLine text="Readable Caplet content is unavailable." />
              </div>
            )}
          </details>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h3 className="text-base font-medium leading-snug">Record</h3>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm">
            <RecordRow label="Source path" value={entry.sourcePath ?? "Not indexed"} />
            <RecordRow label="Workflow" value={entry.workflow?.label ?? "Unknown"} />
            <RecordRow label="Installs" value={installCountDisplay(entry)} />
            <RecordRow label="Revision" value={entry.resolvedRevision ?? "Not indexed"} />
            <RecordRow label="Content hash" value={entry.indexedContentHash ?? "Not indexed"} />
            <RecordRow label="Auth" value={entry.authReadiness ?? "unknown"} />
            <RecordRow label="Setup" value={entry.setupReadiness ?? "unknown"} />
            <RecordRow label="Project Binding" value={entry.projectBindingReadiness ?? "unknown"} />
          </dl>
          {setupActions.length ? (
            <div className="mt-4 flex flex-col gap-2">
              {setupActions.map((setupAction) => (
                <Badge
                  key={`${setupAction.kind}-${setupAction.label}`}
                  variant={setupAction.required ? "destructive" : "outline"}
                >
                  {setupAction.label}
                </Badge>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function CatalogIcon({ entry, large = false }: { entry: CatalogEntry; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [entry.icon?.url]);
  const iconUrl = entry.icon?.url;
  const iconBlocked = iconUrl === "https://www.cloudflare.com/favicon.ico";
  if (iconUrl && !failed && !iconBlocked) {
    return (
      <img
        className={
          large
            ? "size-14 shrink-0 rounded-lg border bg-background object-contain p-2"
            : "size-9 shrink-0 rounded-lg border bg-background object-contain p-1.5"
        }
        src={iconUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className={
        large
          ? "grid size-14 shrink-0 place-items-center rounded-lg border bg-muted font-mono text-xl font-extrabold text-muted-foreground"
          : "grid size-9 shrink-0 place-items-center rounded-lg border bg-muted font-mono text-sm font-extrabold text-muted-foreground"
      }
      aria-hidden="true"
    >
      {entry.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function SafetyWarnings({ warnings }: { warnings: CatalogEntry["warnings"] }) {
  if (!warnings?.length) return null;
  return (
    <Alert>
      <AlertTriangleIcon />
      <AlertTitle>Inspect before installing</AlertTitle>
      <AlertDescription>
        <ul className="mt-2 flex flex-col gap-2">
          {warnings.map((warning) => (
            <li key={warning.code ?? warning.label}>
              <strong>{warning.label}</strong>
              {warning.message ? <span> — {warning.message}</span> : null}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function CatalogLoadingRows() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="h-[72px] rounded-lg bg-muted" />
      ))}
    </div>
  );
}

function CatalogError({ message }: { message: string }) {
  return (
    <Alert variant="destructive" className="m-3">
      <AlertTriangleIcon />
      <AlertTitle>Catalog unavailable</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function RecordRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <dt className="font-mono text-xs font-bold text-muted-foreground">{label}</dt>
      <dd className="m-0 break-words [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function rankEntry(entry: CatalogEntry): number {
  return entry.trustLevel === "official" ? 1 : 0;
}

function installCountDisplay(_entry: CatalogEntry): string {
  return "<10";
}

function installReviewSummary(entry: CatalogEntry): string {
  const warnings = entry.warnings?.length
    ? entry.warnings.map((warning) => warning.label).join(", ")
    : "none";
  return [
    `${entry.name} can add local capabilities.`,
    `Trust: ${entry.trustLevel ?? "community"}.`,
    `Auth: ${entry.authReadiness ?? "unknown"}.`,
    `Setup: ${entry.setupReadiness ?? "unknown"}.`,
    `Project Binding: ${entry.projectBindingReadiness ?? "unknown"}.`,
    `Warnings: ${warnings}.`,
    "Type the exact Caplet id only after reviewing this readiness summary.",
  ].join(" ");
}

function catalogLabel(value: string): string {
  if (value === "all") return "All";
  if (value === "rank") return "Most relevant";
  return value.replace(/_/gu, " ").replace(/^./u, (char) => char.toUpperCase());
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

function trimFrontmatter(markdown: string): string {
  return markdown.replace(/^---[\s\S]*?---\s*/u, "").trim();
}
function VaultPage({
  data,
  loading,
  action,
}: {
  data: DashboardData;
  loading: boolean;
  action: (label: string, callback: () => Promise<unknown>) => Promise<void>;
}) {
  const confirm = useConfirm();
  const dismissConfirmation = useDismissConfirmation();
  const { confirmTyped } = useActionConfirm();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
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
    await action(replacing ? "Vault value replaced" : "Vault value saved", () =>
      dashboardApi("vault/values", {
        method: "POST",
        body: JSON.stringify({ key, value, force: replacing }),
      }),
    );
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
                              revealed = await dashboardApi<{ value: string }>("vault/reveal", {
                                method: "POST",
                                body: JSON.stringify({
                                  key: entry.key,
                                  confirmation,
                                }),
                              });
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
                          await action("Vault value deleted", () =>
                            dashboardApi(`vault/values/${entry.key}/delete`, {
                              method: "POST",
                              body: "{}",
                            }),
                          );
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
  action,
}: {
  data: DashboardData;
  loading: boolean;
  action: (label: string, callback: () => Promise<unknown>) => Promise<void>;
}) {
  const confirm = useConfirm();
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
                onClick={async () => {
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
                  await action("Restart requested", () =>
                    dashboardApi("runtime/restart", { method: "POST", body: "{}" }),
                  );
                }}
              >
                Restart runtime
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
