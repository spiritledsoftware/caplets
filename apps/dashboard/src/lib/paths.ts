const DASHBOARD_SEGMENT = "dashboard";
const DEFAULT_DASHBOARD_BASE_PATH = `/${DASHBOARD_SEGMENT}`;

function configuredDashboardBasePath(): string | undefined {
  if (typeof document === "undefined") return undefined;

  const configuredBase = document
    .querySelector<HTMLMetaElement>('meta[name="caplets-dashboard-base-path"]')
    ?.content.trim();

  if (!configuredBase) return undefined;
  const withLeadingSlash = configuredBase.startsWith("/") ? configuredBase : `/${configuredBase}`;
  return withLeadingSlash.replace(/\/+$/u, "");
}

export function dashboardBasePath(pathname?: string): string {
  const configuredBase = configuredDashboardBasePath();
  if (configuredBase !== undefined) return configuredBase;

  const currentPathname =
    pathname ??
    (typeof globalThis.location?.pathname === "string"
      ? globalThis.location.pathname
      : DEFAULT_DASHBOARD_BASE_PATH);
  const normalizedPathname = currentPathname.startsWith("/")
    ? currentPathname
    : `/${currentPathname}`;
  const segments = normalizedPathname.split("/").filter(Boolean);
  const dashboardIndex = segments.lastIndexOf(DASHBOARD_SEGMENT);

  if (dashboardIndex === -1) return DEFAULT_DASHBOARD_BASE_PATH;
  return `/${segments.slice(0, dashboardIndex + 1).join("/")}`;
}

export function dashboardPath(path = "", pathname?: string): string {
  const basePath = dashboardBasePath(pathname);
  const trimmedPath = path.replace(/^\/+|\/+$/gu, "");
  return trimmedPath ? `${basePath}/${trimmedPath}` : basePath || "/";
}

export function dashboardApiUrl(path: string): string {
  return dashboardPath(`api/${path.replace(/^\/+|\/+$/gu, "")}`);
}
