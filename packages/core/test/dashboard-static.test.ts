import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dashboardShell, dashboardStaticResponse } from "../src/dashboard/routes";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dashboard static serving", () => {
  it("serves the exact canonical page set without slash or prefix aliases", async () => {
    const dashboardDistDir = dashboardFixture();
    const pages = [
      "",
      "caplets",
      "catalog",
      "stored-caplets",
      "vault",
      "access",
      "activity",
      "runtime",
      "settings",
    ] as const;

    for (const page of pages) {
      const path = page ? `/dashboard/${page}` : "/dashboard";
      const response = dashboardStaticResponse(path, dashboardDistDir);
      expect(response, path).toBeInstanceOf(Response);
      expect(response?.status, path).toBe(200);
      expect(response?.headers.get("cache-control"), path).toBe("no-store");
      await expect(response?.text()).resolves.toContain(page || "overview");

      const slashPath = `${path}/`;
      expect(dashboardStaticResponse(slashPath, dashboardDistDir), slashPath).toBeUndefined();
    }

    expect(dashboardStaticResponse("/removed/dashboard/access", dashboardDistDir)).toBeUndefined();
    expect(dashboardStaticResponse("/dashboard/unknown", dashboardDistDir)).toBeUndefined();
    expect(dashboardStaticResponse("/dashboard/%61ccess", dashboardDistDir)).toBeUndefined();
  });

  it("serves assets only from the fixed dashboard namespace", async () => {
    const dashboardDistDir = dashboardFixture();

    const asset = dashboardStaticResponse("/dashboard/_astro/client.js", dashboardDistDir);
    expect(asset).toBeInstanceOf(Response);
    expect(asset?.headers.get("content-type")).toContain("javascript");
    expect(asset?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    await expect(asset?.text()).resolves.toBe("console.log('dashboard')");

    const icon = dashboardStaticResponse("/dashboard/icon.png", dashboardDistDir);
    expect(icon?.headers.get("content-type")).toBe("image/png");
    await expect(icon?.text()).resolves.toBe("dashboard-icon");

    expect(dashboardStaticResponse("/_astro/client.js", dashboardDistDir)).toBeUndefined();
    expect(dashboardStaticResponse("/icon.png", dashboardDistDir)).toBeUndefined();
    expect(
      dashboardStaticResponse("/dashboard/_astro/%63lient.js", dashboardDistDir),
    ).toBeUndefined();
    expect(
      dashboardStaticResponse("/removed/dashboard/_astro/client.js", dashboardDistDir),
    ).toBeUndefined();
  });

  it("reserves dashboard private APIs before static and SPA resolution", () => {
    const dashboardDistDir = dashboardFixture();

    expect(dashboardStaticResponse("/dashboard/api", dashboardDistDir)).toBeUndefined();
    expect(dashboardStaticResponse("/dashboard/api/session", dashboardDistDir)).toBeUndefined();
    expect(
      dashboardStaticResponse("/dashboard/api/private/vault-reveals", dashboardDistDir),
    ).toBeUndefined();
  });

  it("serves catalog details only for one safe encoded segment", async () => {
    const dashboardDistDir = dashboardFixture();
    const detail = dashboardStaticResponse(
      "/dashboard/catalog/github%3Aspiritledsoftware%3Acaplets%3Asample%252FCAPLET.md",
      dashboardDistDir,
    );

    expect(detail).toBeInstanceOf(Response);
    await expect(detail?.text()).resolves.toContain("catalog");

    for (const path of [
      "/dashboard/catalog/owner%2Frepo",
      "/dashboard/catalog/%2e",
      "/dashboard/catalog/%2e%2e",
      "/dashboard/catalog/key/extra",
      "/dashboard/catalog/official%3Aexample/",
    ]) {
      expect(dashboardStaticResponse(path, dashboardDistDir), path).toBeUndefined();
    }
  });

  it("does not serve paths that escape the static dist directory", () => {
    const parentDir = tempDir("caplets-dashboard-static-root-");
    const dashboardDistDir = join(parentDir, "dist");
    mkdirSync(dashboardDistDir, { recursive: true });
    writeFileSync(join(parentDir, "outside-dashboard-secret.txt"), "secret");

    expect(
      dashboardStaticResponse("/dashboard/../outside-dashboard-secret.txt", dashboardDistDir),
    ).toBeUndefined();
    expect(
      dashboardStaticResponse("/dashboard/%2e%2e%2foutside-dashboard-secret.txt", dashboardDistDir),
    ).toBeUndefined();
    expect(dashboardStaticResponse("/dashboard/%", dashboardDistDir)).toBeUndefined();
  });

  it("renders the unbuilt shell without deployment-prefix metadata", () => {
    const html = dashboardShell();

    expect(html).toContain("pnpm --filter @caplets/dashboard build");
    expect(html).not.toContain("caplets-service-root-path");
    expect(html).not.toContain("caplets-dashboard-base-path");
  });
});

function dashboardFixture(): string {
  const dashboardDistDir = tempDir("caplets-dashboard-dist-");
  const pages = [
    ["", "overview"],
    ["caplets", "caplets"],
    ["catalog", "catalog"],
    ["stored-caplets", "stored-caplets"],
    ["vault", "vault"],
    ["access", "access"],
    ["activity", "activity"],
    ["runtime", "runtime"],
    ["settings", "settings"],
  ] as const;

  for (const [route, content] of pages) {
    const dir = join(dashboardDistDir, route);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), `<main>${content}</main>`);
  }
  mkdirSync(join(dashboardDistDir, "dashboard", "api"), { recursive: true });
  writeFileSync(
    join(dashboardDistDir, "dashboard", "api", "index.html"),
    "<main>must-not-serve</main>",
  );
  mkdirSync(join(dashboardDistDir, "_astro"), { recursive: true });
  writeFileSync(join(dashboardDistDir, "_astro", "client.js"), "console.log('dashboard')");
  writeFileSync(join(dashboardDistDir, "dashboard", "icon.png"), "dashboard-icon");
  writeFileSync(join(dashboardDistDir, "icon.png"), "root-icon-must-not-serve");
  return dashboardDistDir;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
