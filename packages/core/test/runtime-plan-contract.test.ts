import { describe, expect, it } from "vitest";
import {
  HIDDEN_REASON_CODES,
  inferRuntimeFeatures,
  planCapletRuntimeRoute,
  resolveRuntimeResources,
  type HiddenReasonCode,
} from "../src/runtime-plan";

const runtimeCapletFixtures = {
  httpAction: { server: "http_action", backend: "http", expectedRoute: "worker_safe" },
  openapi: { server: "openapi_weather", backend: "openapi", expectedRoute: "worker_safe" },
  graphql: { server: "graphql_inventory", backend: "graphql", expectedRoute: "worker_safe" },
  remoteMcp: {
    server: "remote_mcp",
    backend: "mcp",
    transport: "http",
    expectedRoute: "worker_safe",
  },
  cli: { server: "cli_process", backend: "cli", command: "node", expectedRoute: "process" },
  stdioMcp: {
    server: "stdio_mcp",
    backend: "mcp",
    transport: "stdio",
    command: "node",
    expectedRoute: "process",
  },
  setupBacked: {
    server: "setup_backed",
    backend: "cli",
    setup: { commands: [{ label: "Install", command: "pnpm", args: ["install"] }] },
    expectedRoute: "process",
  },
  docker: {
    server: "docker_tool",
    backend: "cli",
    runtime: { features: ["docker"] },
    expectedRoute: "process",
  },
  browser: {
    server: "browser_tool",
    backend: "cli",
    runtime: { features: ["browser"] },
    expectedRoute: "process",
  },
  projectBound: {
    server: "project_bound",
    backend: "cli",
    projectBinding: { required: true },
    expectedRoute: "project_bound_process",
  },
  localOnly: { server: "local_only", backend: "unknown", expectedRoute: "local_only" },
} as const;

describe("hosted runtime route-plan contract", () => {
  it("classifies canonical fixture routes", () => {
    for (const fixture of Object.values(runtimeCapletFixtures)) {
      expect(planCapletRuntimeRoute(fixture).route).toBe(fixture.expectedRoute);
    }
  });

  it("infers Docker and browser features from explicit and command provenance", () => {
    expect(inferRuntimeFeatures({ runtime: { features: ["docker"] } }).features).toContain(
      "docker",
    );
    expect(inferRuntimeFeatures({ runtime: { features: ["browser"] } }).features).toContain(
      "browser",
    );
    expect(
      inferRuntimeFeatures({
        setup: { commands: [{ label: "Build", command: "docker", args: ["build", "."] }] },
      }).features,
    ).toContain("docker");
    expect(
      inferRuntimeFeatures({ command: "playwright", backend: "mcp", transport: "stdio" }).features,
    ).toContain("browser");
  });

  it("resolves Hosted Sandbox resource classes conservatively", () => {
    expect(resolveRuntimeResources({ features: [], backend: "http" }).class).toBe("small");
    expect(resolveRuntimeResources({ features: [], backend: "cli" }).class).toBe("medium");
    expect(resolveRuntimeResources({ features: ["docker"], backend: "cli" }).class).toBe("large");
    expect(resolveRuntimeResources({ features: ["browser"], backend: "cli" }).class).toBe("large");
    expect(resolveRuntimeResources({ features: ["docker", "browser"], backend: "cli" }).class).toBe(
      "heavy",
    );
    expect(
      resolveRuntimeResources({
        features: ["docker"],
        backend: "cli",
        policy: { maxClass: "medium" },
      }),
    ).toMatchObject({ class: "medium", cappedByPolicy: "medium" });
  });

  it("exports every canonical hidden reason code as a stable literal union", () => {
    const required: HiddenReasonCode[] = [
      "setup_required",
      "setup_running",
      "setup_failed",
      "verify_failed",
      "backend_auth_required",
      "backend_check_failed",
      "project_binding_required",
      "project_binding_syncing",
      "project_binding_blocked",
      "project_binding_stale",
      "provider_unavailable",
      "provider_capacity_exhausted",
      "provider_queue_timeout",
      "policy_denied",
      "billing_required",
      "subscription_past_due",
      "usage_limit_reached",
      "email_verification_required",
      "docker_required",
      "docker_denied",
      "browser_required",
      "browser_denied",
      "resource_class_denied",
      "local_only",
      "invalid_bundle",
      "unsupported_backend",
    ];

    expect(HIDDEN_REASON_CODES).toEqual(required);
  });
});
