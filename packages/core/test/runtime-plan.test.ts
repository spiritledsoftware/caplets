import { describe, expect, it } from "vitest";
import type { CapletConfig } from "../src/config";
import { planCapletRuntimeRoutes } from "../src/runtime-plan/planner";

describe("runtime route planning", () => {
  it("plans routes without an implicit deployment target", () => {
    expect(routes([caplet("cli", { backend: "cli" })])).toEqual([
      { id: "cli", route: "process", setupTarget: undefined },
    ]);
    expect(
      routes([caplet("stdio", { backend: "mcp", transport: "stdio", command: "uvx" })]),
    ).toEqual([{ id: "stdio", route: "process", setupTarget: undefined }]);
    expect(routes([caplet("command", { backend: "mcp", command: "node" })])).toEqual([
      { id: "command", route: "process", setupTarget: undefined },
    ]);
    expect(
      routes([
        caplet("remote", { backend: "mcp", transport: "sse", url: "https://example.com/sse" }),
      ]),
    ).toEqual([{ id: "remote", route: "worker_safe", setupTarget: undefined }]);
    expect(routes([caplet("http-api", { backend: "http" })])).toEqual([
      { id: "http-api", route: "worker_safe", setupTarget: undefined },
    ]);
    expect(routes([caplet("setup", { backend: "openapi", setup: setup() })], "local")).toEqual([
      { id: "setup", route: "process", setupTarget: "local_host" },
    ]);
    expect(routes([caplet("setup", { backend: "openapi", setup: setup() })], "remote")).toEqual([
      { id: "setup", route: "process", setupTarget: "remote_host" },
    ]);
    expect(
      routes([caplet("project", { backend: "cli", projectBinding: { required: true } })]),
    ).toEqual([{ id: "project", route: "project_bound_process", setupTarget: undefined }]);
    expect(routes([caplet("unknown", { backend: "native" })])).toEqual([
      { id: "unknown", route: "local_only", setupTarget: undefined },
    ]);
  });

  it("keeps Caplet sets worker-safe facades even when children require process routes", () => {
    const plans = planCapletRuntimeRoutes([
      caplet("child", { backend: "cli" }),
      caplet("set", { backend: "caplets", dependencies: ["child"] }),
      caplet("remote-set", { backend: "caplets", dependencies: ["worker"] }),
      caplet("worker", { backend: "openapi" }),
    ]);

    expect(plans.find((plan) => plan.id === "set")).toEqual(
      expect.objectContaining({ route: "worker_safe" }),
    );
    expect(plans.find((plan) => plan.id === "remote-set")).toEqual(
      expect.objectContaining({ route: "worker_safe" }),
    );
  });

  it("adds runtime feature provenance and resource defaults to plans", () => {
    const [plan] = planCapletRuntimeRoutes([
      caplet("browser", {
        backend: "cli",
        runtime: { features: ["docker"] },
        actions: {
          inspect: { command: "npx", args: ["-y", "@playwright/mcp"] },
        },
      }),
    ]);

    expect(plan?.runtime).toMatchObject({
      features: ["docker", "browser"],
      resources: { class: "heavy", cpu: 8, memoryMb: 16384, diskMb: 40960 },
    });
    expect(plan?.runtime.featureProvenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: "docker", source: "explicit" }),
        expect.objectContaining({
          feature: "browser",
          source: "cli.action",
          command: "npx -y @playwright/mcp",
          matched: "@playwright/mcp",
        }),
      ]),
    );
  });
});

function routes(caplets: CapletConfig[], deployment?: "local" | "remote") {
  return planCapletRuntimeRoutes(caplets, deployment === undefined ? {} : { deployment }).map(
    (plan) => ({
      id: plan.id,
      route: plan.route,
      setupTarget: plan.setupTarget,
    }),
  );
}

function caplet(id: string, overrides: Record<string, unknown>): CapletConfig {
  return {
    server: id,
    name: id,
    description: `Test Caplet ${id}.`,
    disabled: false,
    ...overrides,
  } as CapletConfig;
}

function setup() {
  return { commands: [{ label: "Install", command: "pnpm" }] };
}
