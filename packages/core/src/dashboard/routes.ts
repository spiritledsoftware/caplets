import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
  const cacheControl = requestPath.startsWith("/_astro/")
    ? "public, max-age=31536000, immutable"
    : "no-store";
  return new Response(readFileSync(filePath), {
    headers: { "cache-control": cacheControl, "content-type": contentType(filePath) },
  });
}

function dashboardStaticFilePath(requestPath: string, distDir: string): string | undefined {
  const decodedPath = safeDecodePath(requestPath);
  if (!decodedPath || hasUnsafePathSegment(decodedPath)) return undefined;
  if (decodedPath.startsWith("/_astro/")) {
    return safeJoin(distDir, decodedPath.slice(1));
  }
  if (decodedPath === "/dashboard" || decodedPath === "/dashboard/") {
    return safeJoin(distDir, "dashboard/index.html");
  }
  if (!decodedPath.startsWith("/dashboard/")) return undefined;
  if (decodedPath.startsWith("/dashboard/api/")) return undefined;
  const route = decodedPath.slice("/dashboard/".length).replace(/\/$/u, "");
  if (!route) return safeJoin(distDir, "dashboard/index.html");
  if (isCatalogDetailRequest(requestPath)) {
    return safeJoin(distDir, "dashboard/catalog/index.html");
  }
  if (route.includes(".")) return safeJoin(distDir, route);
  return safeJoin(distDir, `dashboard/${route}/index.html`);
}

function hasUnsafePathSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

function isCatalogDetailRequest(requestPath: string): boolean {
  const normalizedPath = requestPath.replace(/\/+$/u, "");
  const prefix = "/dashboard/catalog/";
  if (!normalizedPath.startsWith(prefix)) return false;
  const encodedEntryKey = normalizedPath.slice(prefix.length);
  if (!encodedEntryKey || encodedEntryKey.includes("/")) return false;
  return !/\.(?:css|gif|ico|jpe?g|js|json|mjs|png|svg|webp)$/iu.test(encodedEntryKey);
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
