import { describe, expect, it } from "vitest";

import type { CapletsError } from "../src/errors";
import {
  CURRENT_HOST_NAMESPACES,
  CURRENT_HOST_PATHS,
  currentHostAdminPath,
  currentHostAdminUrl,
  currentHostAttachUrl,
  currentHostProjectBindingPath,
  currentHostProjectBindingWebSocketUrl,
  currentHostV1Path,
  currentHostV1Url,
  currentHostUrl,
} from "../src/current-host/topology";
import { canonicalizeCurrentHostOrigin } from "../src/current-host/origin";

describe("Current Host topology", () => {
  it("owns the four immutable protocol namespaces and canonical roots", () => {
    expect(CURRENT_HOST_NAMESPACES).toEqual({
      wellKnown: "/.well-known/caplets",
      api: "/api",
      mcp: "/mcp",
      dashboard: "/dashboard",
    });
    expect(CURRENT_HOST_PATHS).toEqual({
      openApi: "/api/openapi.json",
      apiV1: "/api/v1",
      health: "/api/v1/healthz",
      admin: "/api/v2/admin",
      dashboardAssets: "/dashboard/_astro",
      dashboardApi: "/dashboard/api",
      dashboardPrivateApi: "/dashboard/api/private",
    });
    expect(Object.isFrozen(CURRENT_HOST_NAMESPACES)).toBe(true);
    expect(Object.isFrozen(CURRENT_HOST_PATHS)).toBe(true);
  });

  it("builds only the surviving fixed v1 leaves", () => {
    expect(currentHostV1Path("health")).toBe("/api/v1/healthz");
    expect(currentHostV1Path("remoteLoginStart")).toBe("/api/v1/remote/login/start");
    expect(currentHostV1Path("remoteLoginPoll")).toBe("/api/v1/remote/login/poll");
    expect(currentHostV1Path("remoteLoginRefresh")).toBe("/api/v1/remote/login/refresh");
    expect(currentHostV1Path("remoteLoginComplete")).toBe("/api/v1/remote/login/complete");
    expect(currentHostV1Path("remoteLoginCancel")).toBe("/api/v1/remote/login/cancel");
    expect(currentHostV1Path("remoteRefresh")).toBe("/api/v1/remote/refresh");
    expect(currentHostV1Path("remoteClient")).toBe("/api/v1/remote/client");
    expect(currentHostAttachUrl("https://host.example")).toEqual(
      new URL("https://host.example/api/v1/attach"),
    );
    expect(currentHostV1Path("attachSessions")).toBe("/api/v1/attach/sessions");
    expect(currentHostV1Path("attachManifest")).toBe("/api/v1/attach/manifest");
    expect(currentHostV1Path("attachEvents")).toBe("/api/v1/attach/events");
    expect(currentHostV1Path("attachInvoke")).toBe("/api/v1/attach/invoke");
    expect(currentHostV1Path("projectBindingConnect")).toBe(
      "/api/v1/attach/project-bindings/connect",
    );
    expect(currentHostV1Path("projectBindingSessions")).toBe(
      "/api/v1/attach/project-bindings/sessions",
    );
  });

  it("builds strict Admin and Project Binding parameter paths", () => {
    expect(currentHostAdminPath()).toBe("/api/v2/admin");
    expect(currentHostAdminPath("/catalog/entries/{entryKey}")).toBe(
      "/api/v2/admin/catalog/entries/{entryKey}",
    );
    expect(currentHostProjectBindingPath("binding / one", "status")).toBe(
      "/api/v1/attach/project-bindings/binding%20%2F%20one/status",
    );
    expect(currentHostProjectBindingPath("binding-1", "session")).toBe(
      "/api/v1/attach/project-bindings/binding-1/session",
    );
    expect(currentHostProjectBindingPath("binding-1", "heartbeat")).toBe(
      "/api/v1/attach/project-bindings/binding-1/heartbeat",
    );
    expect(() => currentHostAdminPath("catalog/entries" as never)).toThrow(/relative path/u);
    expect(() => currentHostAdminPath("/catalog/entries/")).toThrow(/relative path/u);
    expect(() => currentHostProjectBindingPath("", "status")).toThrow(/binding ID/u);
  });

  it("resolves named canonical URLs without accepting a prefix", () => {
    expect(currentHostUrl("https://host.example:8443/", "mcp")).toEqual(
      new URL("https://host.example:8443/mcp"),
    );
    expect(currentHostV1Url("http://[::1]:5387/", "health")).toEqual(
      new URL("http://[::1]:5387/api/v1/healthz"),
    );
    expect(currentHostAdminUrl("https://host.example", "/host")).toEqual(
      new URL("https://host.example/api/v2/admin/host"),
    );
    expect(currentHostProjectBindingWebSocketUrl("https://host.example:8443")).toEqual(
      new URL("wss://host.example:8443/api/v1/attach/project-bindings/connect"),
    );
    expect(currentHostProjectBindingWebSocketUrl("http://127.0.0.1:5387")).toEqual(
      new URL("ws://127.0.0.1:5387/api/v1/attach/project-bindings/connect"),
    );
    expect(() => currentHostUrl("https://host.example/prefix", "mcp")).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });
});

describe("canonicalizeCurrentHostOrigin", () => {
  it.each([
    ["https://CAPLETS.Example.COM/", "https://caplets.example.com"],
    ["https://caplets.example.com:443", "https://caplets.example.com"],
    ["https://caplets.example.com:8443/", "https://caplets.example.com:8443"],
    ["http://LOCALHOST:80/", "http://localhost"],
    ["http://127.42.0.1:5387", "http://127.42.0.1:5387"],
    ["http://[::1]:5387/", "http://[::1]:5387"],
  ])("canonicalizes %s", (input, expected) => {
    expect(canonicalizeCurrentHostOrigin(input)).toBe(expected);
  });

  it.each([
    "https://user:pass@caplets.example.com",
    "https://caplets.example.com/base",
    "https://caplets.example/.",
    "https://caplets.example/foo/..",
    "https://caplets.example/%2e",
    "https://caplets.example\\admin",
    "https://caplets.example.com\n",
    "https://caplets.example.com ",
    "https://caplets.example.com?tenant=team",
    "https://caplets.example.com/#fragment",
    "https://caplets.example.com?",
    "https://caplets.example.com#",
    "file:///tmp/caplets",
    "http://caplets.example.com",
    "not a URL",
  ])("rejects non-origin input %s", (input) => {
    expect(() => canonicalizeCurrentHostOrigin(input)).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });
});
