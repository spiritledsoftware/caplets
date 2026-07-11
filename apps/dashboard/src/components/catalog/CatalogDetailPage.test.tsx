// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogDetailPage, installableDetail, type CatalogDetail } from "./CatalogDetailPage";

const detail: CatalogDetail = {
  entry: {
    entryKey: "stable:key",
    id: "github",
    name: "GitHub",
    description: "Manage repositories",
    tags: ["code"],
    trustLevel: "official",
    setupReadiness: "required",
    authReadiness: "required",
    projectBindingReadiness: "ready",
    source: { repository: "caplets/github" },
    workflow: { label: "MCP" },
    installCountDisplay: "1k",
    resolvedRevision: "abc123",
    indexedContentHash: "sha256:abc",
    sourcePath: "caplets/github/CAPLET.md",
    contentMarkdown: "<script>alert('inert')</script>\n# GitHub",
    installCommand: { text: "caplets install caplets/github github", copyable: true },
    warnings: [
      {
        code: "external",
        severity: "caution",
        label: "External changes",
        message: "Can modify repositories",
      },
    ],
  },
  setupActions: [{ kind: "auth", label: "Authenticate GitHub", required: true }],
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(state: Parameters<typeof CatalogDetailPage>[0]["state"]) {
  await act(async () =>
    root.render(
      <CatalogDetailPage
        state={state}
        installing={false}
        onRetry={vi.fn()}
        onReturn={vi.fn()}
        onInstall={vi.fn()}
        onCopy={vi.fn()}
      />,
    ),
  );
}

describe("CatalogDetailPage", () => {
  it("renders complete available metadata and inert selectable CAPLET.md", async () => {
    await render({ status: "available", detail });
    expect(document.activeElement?.textContent).toBe("GitHub");
    expect(host.textContent).toContain("abc123");
    expect(host.textContent).toContain("sha256:abc");
    expect(host.textContent).toContain("Authenticate GitHub");
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("pre")?.textContent).toContain("<script>alert('inert')</script>");
    const repository = host.querySelector<HTMLAnchorElement>('a[target="_blank"]');
    expect(repository?.protocol).toBe("https:");
    expect(repository?.rel).toContain("noopener");
    expect(repository?.rel).toContain("noreferrer");
  });
  it("offers Retry only for transient failure and Return for every unsafe state", async () => {
    await render({ status: "failed", message: "timeout" });
    expect(host.textContent).toContain("Retry");
    expect(host.textContent).toContain("Return to catalog");
    await render({ status: "unavailable", message: "missing" });
    expect(host.textContent).not.toContain("Retry");
    expect(host.textContent).toContain("Return to catalog");
  });

  it("requires readable content and a copyable nonempty command", () => {
    expect(installableDetail(detail)).toBe(true);
    expect(installableDetail({ entry: { ...detail.entry, contentMarkdown: "" } })).toBe(false);
    expect(
      installableDetail({
        entry: { ...detail.entry, installCommand: { text: "", copyable: true } },
      }),
    ).toBe(false);
    expect(
      installableDetail({
        entry: { ...detail.entry, installCommand: { text: "command", copyable: false } },
      }),
    ).toBe(false);
  });
});
