import { Hono } from "hono";
import { createCloudRuntimeAdapter, type CloudRuntimeAdapterOptions } from "./runtime-adapter";

export type RuntimeHttpOptions = CloudRuntimeAdapterOptions & {
  token: string;
};

export function createRuntimeHttpApp(options: RuntimeHttpOptions): Hono {
  const app = new Hono();
  let adapter: ReturnType<typeof createCloudRuntimeAdapter> | undefined;
  const runtimeAdapter = () => {
    adapter ??= createCloudRuntimeAdapter(options);
    return adapter;
  };

  app.use("/runtime/*", async (c, next) => {
    const authorization = c.req.header("authorization") ?? "";
    if (authorization !== `Bearer ${options.token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/healthz", (c) => c.json({ status: "ok", runtimeId: options.runtimeId }));

  app.post("/runtime/tools/list", async (c) => c.json(await runtimeAdapter().listTools()));

  app.post("/runtime/tools/call", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; arguments?: unknown };
    if (!body.name) return c.json({ error: "tool_name_required" }, 400);
    return c.json(await runtimeAdapter().callTool(body.name, body.arguments ?? {}));
  });

  app.post("/runtime/caplets/:id/check", async (c) => {
    return c.json(await runtimeAdapter().checkBackend(c.req.param("id")));
  });

  app.get("/runtime/caplets/:id/setup", async (c) => {
    return c.json(await runtimeAdapter().setupPlan(c.req.param("id")));
  });

  app.post("/runtime/caplets/:id/setup/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      approved?: boolean;
      actor?: "cli-interactive" | "cli-yes" | "ui" | "automation";
    };
    return c.json(
      await runtimeAdapter().runSetup(c.req.param("id"), {
        approved: body.approved === true,
        actor: body.actor ?? "automation",
      }),
    );
  });

  return app;
}
