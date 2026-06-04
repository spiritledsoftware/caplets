import { describe, expect, it } from "vitest";
import { attachProjectOnce, resolveAttachOptions } from "../src/project-binding/attach";
import { runCli } from "../src/cli";
import { CloudAuthStore } from "../src/cloud-auth/store";
import type { ProjectBindingWebSocket } from "../src/project-binding/transport";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";

describe("caplets attach CLI", () => {
  it("shows attach help", async () => {
    const out: string[] = [];

    await runCli(["attach", "--help"], { writeOut: (value) => out.push(value) });

    expect(out.join("")).toContain("Attach the current project to a remote Caplets runtime.");
    expect(out.join("")).toContain("--remote-url <url>");
    expect(out.join("")).toContain("--workspace <workspace>");
    expect(out.join("")).toContain("--once");
  });

  it("resolves attach options from flags, env, and the caller cwd", () => {
    const resolved = resolveAttachOptions(
      {
        remoteUrl: "https://caplets.example.com/caplets",
        token: "token",
        workspace: "workspace",
        once: true,
        projectRoot: "/repo",
      },
      { CAPLETS_REMOTE_URL: "https://env.example.com" },
    );

    expect(resolved).toMatchObject({
      projectRoot: "/repo",
      once: true,
      remote: {
        baseUrl: new URL("https://caplets.example.com/caplets"),
        workspace: "workspace",
        auth: { type: "bearer", token: "token" },
      },
    });
  });

  it("reports WebSocket upgrade failures clearly in once mode", async () => {
    await expect(
      attachProjectOnce({
        projectRoot: "/repo",
        remoteUrl: "https://caplets.example.com/caplets",
        fetch: async () => new Response("upgrade blocked", { status: 426 }),
      }),
    ).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
      message: expect.stringContaining("Project Binding WebSocket unavailable"),
    });
  });

  it("probes the HTTP equivalent of the Project Binding WebSocket URL", async () => {
    let requestedUrl: string | undefined;

    await expect(
      attachProjectOnce({
        projectRoot: "/repo",
        remoteUrl: "http://127.0.0.1:8787/caplets",
        fetch: async (url) => {
          requestedUrl = String(url);
          return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      webSocketUrl: "ws://127.0.0.1:8787/caplets/control/project-bindings/connect",
    });
    expect(requestedUrl).toBe("http://127.0.0.1:8787/caplets/control/project-bindings/connect");
  });

  it("runs once from the CLI and reports WebSocket availability", async () => {
    const out: string[] = [];

    await runCli(["attach", "--remote-url", "https://caplets.example.com/caplets", "--once"], {
      fetch: async () => Response.json({ error: "websocket_upgrade_required" }, { status: 426 }),
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).toContain(
      "Project Binding available at wss://caplets.example.com/caplets/control/project-bindings/connect.",
    );
  });

  it("prints structured JSON for CLI WebSocket failures", async () => {
    const out: string[] = [];
    let exitCode = 0;

    await runCli(
      ["attach", "--remote-url", "https://caplets.example.com/caplets", "--once", "--json"],
      {
        fetch: async () => new Response("upgrade blocked", { status: 426 }),
        writeOut: (value) => out.push(value),
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(out.join(""))).toMatchObject({
      ok: false,
      error: { code: "PROJECT_BINDING_WEBSOCKET_UNAVAILABLE" },
    });
  });

  it("rejects attach --workspace when it differs from the saved Selected Workspace", async () => {
    const path = tempCloudAuthPath();
    const out: string[] = [];
    let exitCode = 0;
    await new CloudAuthStore({ path }).save(hostedCredentials({ workspaceSlug: "personal" }));

    await runCli(["attach", "--workspace", "team", "--once", "--json", "--project-root", "/repo"], {
      env: { CAPLETS_CLOUD_AUTH_PATH: path },
      writeOut: (value) => out.push(value),
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(out[0] ?? "{}")).toMatchObject({
      error: {
        code: "workspace_switch_required",
        recoveryCommand: "caplets cloud auth switch <workspace>",
      },
    });
  });

  it("does not print a first-time project sync approval prompt", async () => {
    const path = tempCloudAuthPath();
    const out: string[] = [];
    await new CloudAuthStore({ path }).save(hostedCredentials());

    await runCli(["attach", "--once", "--json", "--project-root", "/repo"], {
      env: { CAPLETS_CLOUD_AUTH_PATH: path },
      fetch: async () => Response.json({ error: "websocket_upgrade_required" }, { status: 426 }),
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).not.toMatch(/approve|approval|confirm/i);
  });

  it("runs long-running attach through a Binding Session and ends cleanly on abort", async () => {
    const path = tempCloudAuthPath();
    const out: string[] = [];
    const controller = new AbortController();
    await new CloudAuthStore({ path }).save(hostedCredentials());
    const session = fakeProjectBindingSession({ onReady: () => controller.abort() });

    await runCli(["attach", "--json", "--project-root", "/repo"], {
      env: { CAPLETS_CLOUD_AUTH_PATH: path },
      fetch: session.fetch,
      writeOut: (value) => out.push(value),
      signal: controller.signal,
      projectBindingWebSocketFactory: session.webSocketFactory,
    });

    const events = out.map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ type: "state", state: "attaching" }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ready",
        bindingId: "binding_1",
        sessionId: "binding_session_1",
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "ended" });
    expect(JSON.stringify(events)).not.toContain("cap_access_secret");
  });
});

function fakeProjectBindingSession(options: { onReady?: () => void } = {}) {
  return {
    fetch: async (url: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      if (String(url).endsWith("/control/project-bindings/sessions")) {
        return Response.json(
          {
            binding: { bindingId: "binding_1", state: "attaching", syncState: "pending" },
            sessionId: "binding_session_1",
          },
          { status: 201 },
        );
      }
      return Response.json({ ok: true, binding: { bindingId: "binding_1" } });
    },
    webSocketFactory: () =>
      new FakeProjectBindingSocket(
        [
          {
            type: "ready",
            bindingId: "binding_1",
            sessionId: "binding_session_1",
            syncState: "idle",
          },
        ],
        options,
      ),
  };
}

class FakeProjectBindingSocket implements ProjectBindingWebSocket {
  readonly readyState = 1;
  private readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  constructor(
    private readonly messages: unknown[],
    private readonly options: { onReady?: () => void },
  ) {
    setTimeout(() => {
      for (const message of this.messages) {
        this.dispatch("message", { data: JSON.stringify(message) });
        if (isReadyMessage(message)) this.options.onReady?.();
      }
    }, 0);
  }

  send(): void {}
  close(): void {}

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  private dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function isReadyMessage(message: unknown): boolean {
  return (
    typeof message === "object" && message !== null && "type" in message && message.type === "ready"
  );
}
