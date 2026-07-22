import { CapletsError } from "../errors";
import { canonicalizeCurrentHostOrigin } from "./origin";

export const CURRENT_HOST_NAMESPACES = Object.freeze({
  wellKnown: "/.well-known/caplets",
  api: "/api",
  mcp: "/mcp",
  dashboard: "/dashboard",
} as const);

export const CURRENT_HOST_PATHS = Object.freeze({
  openApi: "/api/openapi.json",
  apiV1: "/api/v1",
  health: "/api/v1/healthz",
  admin: "/api/v2/admin",
  dashboardAssets: "/dashboard/_astro",
  dashboardApi: "/dashboard/api",
  dashboardPrivateApi: "/dashboard/api/private",
} as const);

const CURRENT_HOST_V1_LEAF_PATHS = Object.freeze({
  health: CURRENT_HOST_PATHS.health,
  remoteLoginStart: "/api/v1/remote/login/start",
  remoteLoginPoll: "/api/v1/remote/login/poll",
  remoteLoginRefresh: "/api/v1/remote/login/refresh",
  remoteLoginComplete: "/api/v1/remote/login/complete",
  remoteLoginCancel: "/api/v1/remote/login/cancel",
  remoteRefresh: "/api/v1/remote/refresh",
  remoteClient: "/api/v1/remote/client",
  attachSessions: "/api/v1/attach/sessions",
  attachManifest: "/api/v1/attach/manifest",
  attachEvents: "/api/v1/attach/events",
  attachInvoke: "/api/v1/attach/invoke",
  projectBindingConnect: "/api/v1/attach/project-bindings/connect",
  projectBindingSessions: "/api/v1/attach/project-bindings/sessions",
} as const);

export const CURRENT_HOST_DASHBOARD_PATHS = Object.freeze({
  loginStart: "/dashboard/api/login/start",
  loginPoll: "/dashboard/api/login/poll",
  loginComplete: "/dashboard/api/login/complete",
  session: "/dashboard/api/session",
  logout: "/dashboard/api/logout",
  vaultReveals: "/dashboard/api/private/vault-reveals",
} as const);

export const CURRENT_HOST_ROUTE_PATTERNS = Object.freeze({
  adminBackendAuthCallback: "/api/v2/admin/backend-auth-flows/:flowId/callback",
  dashboardAssets: "/dashboard/_astro/*",
  dashboardPages: "/dashboard/*",
  attachSession: "/api/v1/attach/sessions/:sessionId",
  projectBindingStatus: "/api/v1/attach/project-bindings/:bindingId/status",
  projectBindingSession: "/api/v1/attach/project-bindings/:bindingId/session",
  projectBindingHeartbeat: "/api/v1/attach/project-bindings/:bindingId/heartbeat",
} as const);

export type CurrentHostPathName =
  | keyof typeof CURRENT_HOST_NAMESPACES
  | keyof typeof CURRENT_HOST_PATHS;
export type CurrentHostV1Leaf = keyof typeof CURRENT_HOST_V1_LEAF_PATHS;
export type CurrentHostProjectBindingLeaf = "status" | "session" | "heartbeat";

export function currentHostUrl(origin: string | URL, name: CurrentHostPathName): URL {
  const path =
    name in CURRENT_HOST_NAMESPACES
      ? CURRENT_HOST_NAMESPACES[name as keyof typeof CURRENT_HOST_NAMESPACES]
      : CURRENT_HOST_PATHS[name as keyof typeof CURRENT_HOST_PATHS];
  return resolveOriginPath(origin, path);
}
export function currentHostAttachUrl(origin: string | URL): URL {
  return resolveOriginPath(origin, "/api/v1/attach");
}

export function currentHostV1Path(leaf: CurrentHostV1Leaf): string {
  return CURRENT_HOST_V1_LEAF_PATHS[leaf];
}

export function currentHostV1Url(origin: string | URL, leaf: CurrentHostV1Leaf): URL {
  return resolveOriginPath(origin, currentHostV1Path(leaf));
}

export function currentHostAdminPath(relativePath: `/${string}` | "" = ""): string {
  if (relativePath === "") return CURRENT_HOST_PATHS.admin;
  assertStrictRelativePath(relativePath);
  return `${CURRENT_HOST_PATHS.admin}${relativePath}`;
}

export function currentHostAdminUrl(
  origin: string | URL,
  relativePath: `/${string}` | "" = "",
): URL {
  return resolveOriginPath(origin, currentHostAdminPath(relativePath));
}

export function currentHostProjectBindingPath(
  bindingId: string,
  leaf: CurrentHostProjectBindingLeaf,
): string {
  if (!bindingId) {
    throw new CapletsError("REQUEST_INVALID", "Project Binding path requires a binding ID.");
  }
  return `/api/v1/attach/project-bindings/${encodeURIComponent(bindingId)}/${leaf}`;
}

export function currentHostProjectBindingWebSocketUrl(origin: string | URL): URL {
  const url = currentHostV1Url(origin, "projectBindingConnect");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function resolveOriginPath(origin: string | URL, path: string): URL {
  const canonicalOrigin = canonicalizeCurrentHostOrigin(
    typeof origin === "string" ? origin : origin.href,
  );
  return new URL(path, canonicalOrigin);
}

function assertStrictRelativePath(path: string): asserts path is `/${string}` {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.endsWith("/") ||
    path.includes("//") ||
    path.includes("?") ||
    path.includes("#") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Admin relative path must start with one slash and contain no trailing slash, empty segment, query, fragment, or dot segment.",
    );
  }
}
