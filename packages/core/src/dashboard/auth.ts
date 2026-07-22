import { DASHBOARD_SESSION_COOKIE } from "./types";

export function dashboardSessionCookie(value: string, options: { secure: boolean }): string {
  return [
    `${DASHBOARD_SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    options.secure ? "Secure" : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

export function expiredDashboardSessionCookie(path: string): string {
  return `${DASHBOARD_SESSION_COOKIE}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0`;
}
