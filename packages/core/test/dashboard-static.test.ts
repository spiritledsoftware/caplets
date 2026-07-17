import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletsEngine } from "../src/engine";
import { createHttpServeApp } from "../src/serve/http";
import { dashboardStaticResponse } from "../src/dashboard/routes";
import type { HttpServeOptions } from "../src/serve/options";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dashboard static serving", () => {
  it("serves built dashboard pages and assets while preserving API precedence", async () => {
    const dashboardDistDir = tempDir("caplets-dashboard-dist-");
    mkdirSync(join(dashboardDistDir, "dashboard", "access"), { recursive: true });
    mkdirSync(join(dashboardDistDir, "dashboard", "catalog"), { recursive: true });
    mkdirSync(join(dashboardDistDir, "_astro"), { recursive: true });
    writeFileSync(
      join(dashboardDistDir, "dashboard", "index.html"),
      '<div id="react-dashboard">Overview</div>',
    );
    writeFileSync(
      join(dashboardDistDir, "dashboard", "access", "index.html"),
      '<div id="react-dashboard">Access</div>',
    );
    writeFileSync(
      join(dashboardDistDir, "dashboard", "catalog", "index.html"),
      '<div id="react-dashboard">Catalog</div>',
    );
    writeFileSync(join(dashboardDistDir, "_astro", "client.js"), "console.log('dashboard')");
    writeFileSync(join(dashboardDistDir, "icon.png"), "png");

    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions(tempDir("caplets-dashboard-static-state-")),
      engine,
      {
        dashboardDistDir,
        writeErr: () => {},
      },
    );

    const overview = await app.request("http://127.0.0.1:5387/dashboard");
    expect(overview.status).toBe(200);
    await expect(overview.text()).resolves.toContain("Overview");

    const access = await app.request("http://127.0.0.1:5387/dashboard/access");
    expect(access.status).toBe(200);
    await expect(access.text()).resolves.toContain("Access");

    const catalogDetail = await app.request(
      "http://127.0.0.1:5387/dashboard/catalog/github%3Aowner%2Frepo%3Acaplet",
    );
    expect(catalogDetail.status).toBe(200);
    await expect(catalogDetail.text()).resolves.toContain("Catalog");

    const asset = await app.request("http://127.0.0.1:5387/_astro/client.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const icon = await app.request("http://127.0.0.1:5387/dashboard/icon.png");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");

    const session = await app.request("http://127.0.0.1:5387/dashboard/api/session");
    expect(session.status).toBe(401);

    await engine.close();
  });

  it("serves dashboard HTML and immutable assets under a configured base path", async () => {
    const dashboardDistDir = tempDir("caplets-dashboard-base-dist-");
    mkdirSync(join(dashboardDistDir, "dashboard"), { recursive: true });
    mkdirSync(join(dashboardDistDir, "dashboard", "catalog"), { recursive: true });
    mkdirSync(join(dashboardDistDir, "_astro"), { recursive: true });
    writeFileSync(
      join(dashboardDistDir, "dashboard", "index.html"),
      '<link rel="stylesheet" href="/_astro/base.css"><astro-island component-url="/_astro/base.js" renderer-url="/vendor/_astro/renderer.js">Base path dashboard</astro-island>',
    );
    writeFileSync(
      join(dashboardDistDir, "dashboard", "catalog", "index.html"),
      "<main>Base path catalog</main>",
    );
    writeFileSync(join(dashboardDistDir, "_astro", "base.js"), "export const base = true;");
    writeFileSync(join(dashboardDistDir, "_astro", "base.css"), "body { color: CanvasText; }");

    const { engine } = testEngine();
    const app = createHttpServeApp(
      { ...httpOptions(tempDir("caplets-dashboard-base-state-")), path: "/caplets" },
      engine,
      {
        dashboardDistDir,
        writeErr: () => {},
      },
    );

    const dashboard = await app.request("http://127.0.0.1:5387/caplets/dashboard");
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain('href="/caplets/_astro/base.css"');
    expect(dashboardHtml).toContain('component-url="/caplets/_astro/base.js"');
    expect(dashboardHtml).toContain('renderer-url="/vendor/_astro/renderer.js"');
    expect(dashboardHtml).not.toContain('="/_astro/');

    const catalogDetail = await app.request(
      "http://127.0.0.1:5387/caplets/dashboard/catalog/github%3Aowner%2Frepo%3Acaplet",
    );
    expect(catalogDetail.status).toBe(200);
    await expect(catalogDetail.text()).resolves.toBe("<main>Base path catalog</main>");

    const asset = await app.request("http://127.0.0.1:5387/caplets/_astro/base.js");
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toBe("export const base = true;");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const stylesheet = await app.request("http://127.0.0.1:5387/caplets/_astro/base.css");
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toContain("text/css");

    await engine.close();
  });

  it("does not serve dashboard paths that escape the static dist directory", () => {
    const parentDir = tempDir("caplets-dashboard-static-root-");
    const dashboardDistDir = join(parentDir, "dist");
    mkdirSync(dashboardDistDir, { recursive: true });
    writeFileSync(join(dashboardDistDir, "index.html"), "dashboard");
    writeFileSync(join(parentDir, "outside-dashboard-secret.txt"), "secret");

    expect(
      dashboardStaticResponse("/dashboard/../outside-dashboard-secret.txt", dashboardDistDir),
    ).toBeUndefined();
    expect(
      dashboardStaticResponse("/dashboard/%2e%2e%2foutside-dashboard-secret.txt", dashboardDistDir),
    ).toBeUndefined();
    expect(dashboardStaticResponse("/dashboard/%", dashboardDistDir)).toBeUndefined();
    expect(
      dashboardStaticResponse("/dashboard/catalog/%2e%2e%2fsecret", dashboardDistDir),
    ).toBeUndefined();
    expect(dashboardStaticResponse("/dashboard/catalog/key.js", dashboardDistDir)).toBeUndefined();
  });
});

function testEngine() {
  const dir = tempDir("caplets-dashboard-static-config-");
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      httpApis: {
        status: {
          name: "Status",
          description: "Status API.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    }),
  );
  return { engine: CapletsEngine.unactivatedForTests({ configPath }) };
}

function httpOptions(stateDir: string): HttpServeOptions {
  return {
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
    path: "/",
    auth: { type: "remote_credentials" },
    remoteCredentialStateDir: stateDir,
    allowUnauthenticatedHttp: false,
    warnUnauthenticatedNetwork: false,
    loopback: true,
    trustProxy: false,
  };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
