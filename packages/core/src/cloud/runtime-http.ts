import { Hono } from "hono";
import { CapletsError } from "../errors";
import {
  createCloudRuntimeAdapter,
  type CloudRuntimeAdapter,
  type CloudRuntimeAdapterOptions,
} from "./runtime-adapter";

export type RuntimeHttpOptions = CloudRuntimeAdapterOptions & {
  token: string;
};

export type RuntimeHttpDependencies = Readonly<{
  createAdapter?:
    | ((options: CloudRuntimeAdapterOptions) => Promise<CloudRuntimeAdapter>)
    | undefined;
}>;

export function createRuntimeHttpApp(
  options: RuntimeHttpOptions,
  dependencies: RuntimeHttpDependencies = {},
): Hono {
  const app = new Hono();
  let adapter: Promise<CloudRuntimeAdapter> | undefined;
  const activatedAdapter = (): Promise<CloudRuntimeAdapter> => {
    if (adapter) return adapter;
    const startup: Promise<CloudRuntimeAdapter> = (
      dependencies.createAdapter ?? createCloudRuntimeAdapter
    )(options).catch(() => {
      if (adapter === startup) adapter = undefined;
      throw new CapletsError("SERVER_UNAVAILABLE", "Cloud runtime SQL activation is unavailable.");
    });
    adapter = startup;
    return startup;
  };
  void activatedAdapter().catch(() => undefined);
  app.onError((error, c) => {
    if (
      error instanceof CapletsError &&
      (error.code === "SERVER_UNAVAILABLE" ||
        error.code === "CONFIG_NOT_FOUND" ||
        error.code === "AUTH_FAILED")
    ) {
      return c.json({ error: "storage_unavailable" }, 503);
    }
    return c.json({ error: "internal_error" }, 500);
  });

  app.use("/runtime/*", async (c, next) => {
    const authorization = c.req.header("authorization") ?? "";
    if (authorization !== `Bearer ${options.token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/healthz", async (c) => {
    try {
      const health = await (await activatedAdapter()).health();
      if (!health || health.readiness !== "ready") {
        return c.json({ status: "unavailable", runtimeId: options.runtimeId, health }, 503);
      }
      return c.json({ status: "ready", runtimeId: options.runtimeId, health });
    } catch {
      return c.json({ status: "unavailable", runtimeId: options.runtimeId }, 503);
    }
  });

  app.post("/runtime/tools/list", async (c) =>
    c.json(await (await activatedAdapter()).listTools()),
  );

  app.post("/runtime/tools/call", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; arguments?: unknown };
    if (!body.name) return c.json({ error: "tool_name_required" }, 400);
    return c.json(await (await activatedAdapter()).callTool(body.name, body.arguments ?? {}));
  });

  app.post("/runtime/caplets/:id/check", async (c) => {
    return c.json(await (await activatedAdapter()).checkBackend(c.req.param("id")));
  });

  app.get("/runtime/caplets/:id/setup", async (c) => {
    return c.json(await (await activatedAdapter()).setupPlan(c.req.param("id")));
  });

  app.post("/runtime/caplets/:id/setup/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      approved?: boolean;
      actor?: "cli-interactive" | "cli-yes" | "ui" | "automation";
    };
    return c.json(
      await (
        await activatedAdapter()
      ).runSetup(c.req.param("id"), {
        approved: body.approved === true,
        actor: body.actor ?? "automation",
      }),
    );
  });

  return app;
}
