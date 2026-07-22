const DASHBOARD_BASE_PATH = "/dashboard";

export function dashboardPath(path = ""): string {
  const trimmedPath = path.replace(/^\/+|\/+$/gu, "");
  return trimmedPath ? `${DASHBOARD_BASE_PATH}/${trimmedPath}` : DASHBOARD_BASE_PATH;
}

export function dashboardApiUrl(path: string): string {
  return dashboardPath(`api/${path.replace(/^\/+|\/+$/gu, "")}`);
}
