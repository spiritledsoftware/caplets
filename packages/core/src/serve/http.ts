import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPTransport } from "@hono/mcp";
import { serve, type ServerType } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { logger } from "hono/logger";
import { resolveProjectCapletsRoot } from "../config";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { CapletsError, toSafeError } from "../errors";
import {
  dispatchRemoteCliRequest,
  type RemoteControlDispatchContext,
} from "../remote-control/dispatch";
import type { RemoteCliRequest } from "../remote-control/types";
import type { HttpBasicAuthOptions, HttpServeOptions } from "./options";
import { CapletsMcpSession } from "./session";

type HttpServeIo = {
  writeErr?: (value: string) => void;
  control?: Omit<RemoteControlDispatchContext, "writeErr">;
};

type HttpSession = {
  server: CapletsMcpSession;
  transport: StreamableHTTPTransport;
};

export type CapletsHttpApp = Hono & {
  closeCapletsSessions: () => Promise<void>;
};

export function createHttpServeApp(
  options: HttpServeOptions,
  engine: CapletsEngine,
  io: HttpServeIo = {},
): CapletsHttpApp {
  const app = new Hono() as CapletsHttpApp;
  const sessions = new Map<string, HttpSession>();
  const writeErr = io.writeErr ?? process.stderr.write.bind(process.stderr);
  const paths = servicePaths(options.path);
  app.use(
    "*",
    logger((message, ...rest) => {
      writeErr(`${[message, ...rest].join(" ")}\n`);
    }),
  );

  app.get(paths.base, (c) =>
    c.json({
      name: "caplets",
      transport: "http",
      base: paths.base,
      mcp: paths.mcp,
      control: paths.control,
      health: paths.health,
      auth: { type: "basic", enabled: options.auth.enabled },
    }),
  );

  app.get(paths.health, (c) =>
    c.json({
      status: "ok",
      transport: "http",
      base: paths.base,
      mcpPath: paths.mcp,
      controlPath: paths.control,
      healthPath: paths.health,
    }),
  );

  app.all(paths.mcp, basicAuth(options.auth), async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        return c.json(
          {
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          },
          404,
        );
      }
      return existing.transport.handleRequest(c);
    }

    if (c.req.method !== "POST") {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
          id: null,
        },
        400,
      );
    }

    const nextSessionId = randomUUID();
    const session = await createHttpSession(
      engine,
      nextSessionId,
      options,
      async (closedSessionId) => {
        const closed = sessions.get(closedSessionId);
        sessions.delete(closedSessionId);
        if (closed) {
          await closed.server.close();
        }
      },
    );
    sessions.set(nextSessionId, session);
    return session.transport.handleRequest(c);
  });

  app.post(paths.control, basicAuth(options.auth), async (c) => {
    let request: RemoteCliRequest;
    try {
      const parsed = await c.req.json();
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CapletsError("REQUEST_INVALID", "Control request JSON must be an object");
      }
      request = parsed as RemoteCliRequest;
    } catch (error) {
      const requestError =
        error instanceof CapletsError
          ? error
          : new CapletsError("REQUEST_INVALID", "Control request body must be valid JSON", error);
      const safe = toSafeError(requestError, "REQUEST_INVALID");
      return c.json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
    return c.json(
      await dispatchRemoteCliRequest(request, {
        ...io.control,
        projectCapletsRoot: io.control?.projectCapletsRoot ?? resolveProjectCapletsRoot(),
        writeErr,
      }),
    );
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.closeCapletsSessions = async () => {
    await Promise.allSettled(
      [...sessions.values()].map(async (session) => {
        await session.server.close();
      }),
    );
    sessions.clear();
  };

  if (options.warnUnauthenticatedNetwork) {
    writeErr(
      `Warning: Caplets MCP HTTP server is listening on ${options.host} without authentication.\n`,
    );
  }

  return app;
}

export async function serveHttp(
  options: HttpServeOptions,
  engineOptions: CapletsEngineOptions = {},
  writeErr: (value: string) => void = (value) => process.stderr.write(value),
): Promise<void> {
  const engine = new CapletsEngine(engineOptions);
  const app = createHttpServeApp(options, engine, {
    writeErr,
    control: { ...engineOptions, projectCapletsRoot: resolveProjectCapletsRoot() },
  });
  const paths = servicePaths(options.path);
  const origin = `http://${formatHost(options.host)}:${options.port}`;
  const baseUrl = `${origin}${paths.base === "/" ? "" : paths.base}`;
  const server = serve({ fetch: app.fetch, hostname: options.host, port: options.port }, () => {
    writeErr(`Caplets HTTP service listening on ${baseUrl}\n`);
    writeErr(`MCP endpoint: ${origin}${paths.mcp}\n`);
    writeErr(`Control endpoint: ${origin}${paths.control}\n`);
    writeErr(`Health check: ${origin}${paths.health}\n`);
    writeErr(
      `Basic Auth: ${options.auth.enabled ? `enabled (user: ${options.auth.user})` : "disabled"}\n`,
    );
  });

  installHttpSignalHandlers(server, app, engine, writeErr);
}

export function routePath(base: string, path: string): string {
  return base === "/" ? `/${path}` : `${base}/${path}`;
}

export function servicePaths(base: string): {
  base: string;
  mcp: string;
  control: string;
  health: string;
} {
  return {
    base,
    mcp: routePath(base, "mcp"),
    control: routePath(base, "control"),
    health: routePath(base, "healthz"),
  };
}

async function createHttpSession(
  engine: CapletsEngine,
  sessionId: string,
  options: HttpServeOptions,
  onClose: (sessionId: string) => Promise<void>,
): Promise<HttpSession> {
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: () => sessionId,
    onsessionclosed: onClose,
    ...(options.loopback ? dnsRebindingOptions(options) : {}),
  });
  const server = new CapletsMcpSession(engine);
  await server.connect(transport);
  return { server, transport };
}

function basicAuth(auth: HttpBasicAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!auth.enabled) {
      await next();
      return;
    }
    const header = c.req.header("authorization") ?? "";
    const credentials = parseBasicAuth(header);
    if (
      !credentials ||
      !safeEqual(credentials.user, auth.user) ||
      !safeEqual(credentials.password, auth.password)
    ) {
      c.header("www-authenticate", 'Basic realm="caplets"');
      return c.text("Unauthorized", 401);
    }
    await next();
  };
}

function parseBasicAuth(header: string): { user: string; password: string } | undefined {
  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLocaleLowerCase() !== "basic" || !encoded) {
    return undefined;
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return undefined;
  }
  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

type DnsRebindingOptions = {
  enableDnsRebindingProtection: true;
  allowedHosts: string[];
};

function dnsRebindingOptions(options: HttpServeOptions): DnsRebindingOptions {
  const hostForHeader = options.host === "::1" ? "[::1]" : options.host;
  return {
    enableDnsRebindingProtection: true,
    allowedHosts: [
      options.host,
      hostForHeader,
      `${hostForHeader}:${options.port}`,
      `localhost:${options.port}`,
    ],
  };
}

function installHttpSignalHandlers(
  server: ServerType,
  app: CapletsHttpApp,
  engine: CapletsEngine,
  writeErr: (value: string) => void,
): void {
  let closing: Promise<void> | undefined;
  const close = async () => {
    closing ??= (async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.closeCapletsSessions();
      await engine.close();
    })();
    return closing;
  };
  process.once(
    "SIGINT",
    () =>
      void close()
        .catch((error) => writeErr(`${String(error)}\n`))
        .finally(() => process.exit(130)),
  );
  process.once(
    "SIGTERM",
    () =>
      void close()
        .catch((error) => writeErr(`${String(error)}\n`))
        .finally(() => process.exit(143)),
  );
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
