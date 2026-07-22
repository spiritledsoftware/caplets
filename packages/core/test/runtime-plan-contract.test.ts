import { describe, expect, it } from "vitest";
import {
  HIDDEN_REASON_CODES,
  inferRuntimeFeatures,
  isRuntimeResourceClassAllowed,
  planCapletRuntimeRoute,
  resolveRuntimeResources,
  resourceClassRank,
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

describe("generic runtime route-plan contract", () => {
  it("classifies canonical fixture routes", () => {
    for (const fixture of Object.values(runtimeCapletFixtures)) {
      expect(planCapletRuntimeRoute(fixture).route).toBe(fixture.expectedRoute);
    }
  });

  it.each(["hosted", "self_hosted"])("rejects removed deployment %s", (deployment) => {
    expect(() =>
      planCapletRuntimeRoute(runtimeCapletFixtures.cli, { deployment: deployment as never }),
    ).toThrow("runtime deployment must be one of: local, remote");
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

  it("resolves canonical runtime resource classes conservatively", () => {
    expect(resolveRuntimeResources({ features: [], backend: "http" }).class).toBe("standard");
    expect(resolveRuntimeResources({ features: [], backend: "cli" }).class).toBe("standard");
    expect(resolveRuntimeResources({ features: ["docker"], backend: "cli" }).class).toBe("large");
    expect(resolveRuntimeResources({ features: ["browser"], backend: "cli" }).class).toBe("large");
    expect(resolveRuntimeResources({ features: ["docker", "browser"], backend: "cli" }).class).toBe(
      "heavy",
    );
    expect(
      resolveRuntimeResources({
        features: ["docker"],
        backend: "cli",
        policy: { maxClass: "standard" },
      }),
    ).toMatchObject({ class: "standard", cappedByPolicy: "standard" });
  });

  it.each([{ explicitClass: "small" }, { policy: { maxClass: "medium" } }])(
    "rejects removed hosted resource aliases",
    (input) => {
      expect(() =>
        resolveRuntimeResources({
          features: [],
          ...input,
        } as never),
      ).toThrow(/must be one of: standard, large, heavy/u);
    },
  );
  it("rejects removed resource aliases in raw Caplet plans", () => {
    expect(() =>
      planCapletRuntimeRoute({
        ...runtimeCapletFixtures.cli,
        runtime: { resources: { class: "small" } },
      }),
    ).toThrow("runtime resource class must be one of: standard, large, heavy");
  });

  it.each(["small", "medium"])("rejects removed resource alias %s in public helpers", (value) => {
    expect(() => resourceClassRank(value as never)).toThrow(
      "runtime resource class must be one of: standard, large, heavy",
    );
    expect(() => isRuntimeResourceClassAllowed(value as never, "heavy")).toThrow(
      "runtime resource class must be one of: standard, large, heavy",
    );
  });

  it("exports only generic runtime planning reason codes", () => {
    const required: HiddenReasonCode[] = [
      "setup_required",
      "setup_running",
      "setup_failed",
      "verify_failed",
      "backend_auth_required",
      "backend_check_failed",
      "project_binding_required",
      "project_binding_missing_context",
      "project_binding_unsupported",
      "project_binding_auth_failed",
      "project_binding_metadata_unknown",
      "project_binding_sync_failed",
      "project_binding_retry_exhausted",
      "project_binding_quarantined",
      "project_binding_invalid_cwd",
      "project_binding_policy_denied",
      "project_binding_syncing",
      "project_binding_blocked",
      "project_binding_stale",
      "policy_denied",
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
