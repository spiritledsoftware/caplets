import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_HOST_NAMESPACES, CURRENT_HOST_PATHS } from "../current-host/topology";

const DASHBOARD_PAGE_ROUTES: Record<string, true> = {
  access: true,
  activity: true,
  caplets: true,
  catalog: true,
  runtime: true,
  settings: true,
  "stored-caplets": true,
  vault: true,
};

export function dashboardShell(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Caplets Dashboard</title>
  </head>
  <body>
    <main id="caplets-dashboard">
      <h1>Caplets Admin Dashboard</h1>
      <p>Dashboard assets have not been built yet. Run <code>pnpm --filter @caplets/dashboard build</code>, then restart <code>caplets serve</code>.</p>
    </main>
  </body>
</html>`;
}

export function dashboardStaticResponse(
  requestPath: string,
  distDir = defaultDashboardDistDir(),
): Response | undefined {
  const filePath = dashboardStaticFilePath(requestPath, distDir);
  if (!filePath || !existsSync(filePath)) return undefined;
  const cacheControl = requestPath.startsWith(`${CURRENT_HOST_PATHS.dashboardAssets}/`)
    ? "public, max-age=31536000, immutable"
    : "no-store";
  return new Response(readFileSync(filePath), {
    headers: { "cache-control": cacheControl, "content-type": contentType(filePath) },
  });
}
export function dashboardStaticRouteExists(
  requestPath: string,
  distDir = defaultDashboardDistDir(),
): boolean {
  const filePath = dashboardStaticFilePath(requestPath, distDir);
  return filePath !== undefined && existsSync(filePath);
}

function dashboardStaticFilePath(requestPath: string, distDir: string): string | undefined {
  const decodedPath = safeDecodePath(requestPath);
  if (!decodedPath || hasUnsafePathSegment(decodedPath)) return undefined;
  if (requestPath === CURRENT_HOST_NAMESPACES.dashboard) {
    return safeJoin(distDir, "index.html");
  }
  if (requestPath.endsWith("/")) return undefined;

  const assetPrefix = `${CURRENT_HOST_PATHS.dashboardAssets}/`;
  if (
    requestPath === decodedPath &&
    requestPath.startsWith(assetPrefix) &&
    decodedPath.startsWith(assetPrefix)
  ) {
    return safeJoin(distDir, `_astro/${decodedPath.slice(assetPrefix.length)}`);
  }

  if (
    decodedPath === CURRENT_HOST_PATHS.dashboardApi ||
    decodedPath.startsWith(`${CURRENT_HOST_PATHS.dashboardApi}/`)
  ) {
    return undefined;
  }

  const dashboardPrefix = `${CURRENT_HOST_NAMESPACES.dashboard}/`;
  if (!requestPath.startsWith(dashboardPrefix) || !decodedPath.startsWith(dashboardPrefix)) {
    return undefined;
  }
  const route = decodedPath.slice(dashboardPrefix.length);
  if (requestPath === decodedPath && Object.hasOwn(DASHBOARD_PAGE_ROUTES, route)) {
    return safeJoin(distDir, `${route}/index.html`);
  }
  if (isCatalogDetailRequest(requestPath)) {
    return safeJoin(distDir, "catalog/index.html");
  }
  if (requestPath === decodedPath && !route.includes("/")) {
    return safeJoin(distDir, `dashboard/${route}`);
  }
  return undefined;
}

function hasUnsafePathSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

function isCatalogDetailRequest(requestPath: string): boolean {
  const prefix = `${CURRENT_HOST_NAMESPACES.dashboard}/catalog/`;
  if (!requestPath.startsWith(prefix)) return false;
  const encodedEntryKey = requestPath.slice(prefix.length);
  if (!encodedEntryKey || encodedEntryKey.includes("/")) return false;
  const entryKey = safeDecodePath(encodedEntryKey);
  return (
    entryKey !== undefined &&
    entryKey !== "." &&
    entryKey !== ".." &&
    !entryKey.includes("/") &&
    !hasControlCharacter(entryKey)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeDecodePath(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function safeJoin(root: string, relativePath: string): string | undefined {
  const normalizedRoot = resolve(root);
  const candidate = resolve(normalizedRoot, normalize(relativePath));
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${sep}`)) {
    return undefined;
  }
  return candidate;
}

function defaultDashboardDistDir(): string {
  const repoDistDir = join(process.cwd(), "apps/dashboard/dist");
  if (existsSync(repoDistDir)) return repoDistDir;
  return join(dirname(fileURLToPath(import.meta.url)), "dashboard-static");
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs"))
    return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
