import { DASHBOARD_SESSION_COOKIE } from "../dashboard/types";

export type AdminV2CredentialMode = "bearer" | "dashboard_session" | "credential_free";

export function adminV2CredentialMode(request: Request): AdminV2CredentialMode {
  if (request.headers.has("authorization")) return "bearer";
  return hasDashboardSessionCookie(request.headers.get("cookie"))
    ? "dashboard_session"
    : "credential_free";
}

export function hasDashboardSessionCookie(cookieHeader: string | null | undefined): boolean {
  return (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .some(
      (part) =>
        part === DASHBOARD_SESSION_COOKIE || part.startsWith(`${DASHBOARD_SESSION_COOKIE}=`),
    );
}

export function isSameOriginDashboardRequest(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (origin === null && fetchSite === undefined) return false;

  if (origin !== null) {
    try {
      if (new URL(origin).origin !== new URL(expectedOrigin).origin) return false;
    } catch {
      return false;
    }
  }
  return fetchSite === undefined || fetchSite === "same-origin";
}
