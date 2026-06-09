import { describe, expect, it, vi } from "vitest";
import { createCodeModeCapletsApi, listCodeModeCallableCaplets } from "../src/code-mode/api";
import type { CodeModeCapletHandle } from "../src/code-mode/api";
import { CapletsError } from "../src/errors";
import type { NativeCapletTool, NativeCapletsService } from "../src/native/service";

function service(tools: NativeCapletTool[]): NativeCapletsService {
  return {
    listTools: () => tools,
    execute: vi.fn(async (capletId: string, request: unknown) => ({
      content: [{ type: "text", text: JSON.stringify({ capletId, request }) }],
      structuredContent: { capletId, request },
    })),
    reload: vi.fn(async () => true),
    onToolsChanged: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("Code Mode Caplets API", () => {
  it("lists callable caplets from native service tools", () => {
    const callable = listCodeModeCallableCaplets(
      service([
        {
          caplet: "github",
          toolName: "caplets_github",
          title: "GitHub",
          description: "GitHub repo operations.",
          promptGuidance: [],
        },
      ]),
    );

    expect(callable).toEqual([
      { id: "github", name: "GitHub", description: "GitHub repo operations." },
    ]);
  });

  it("creates strict caplet handles that call existing progressive operations", async () => {
    const native = service([
      {
        caplet: "github",
        toolName: "caplets_github",
        title: "GitHub",
        description: "GitHub repo operations.",
        promptGuidance: [],
      },
    ]);
    const api = createCodeModeCapletsApi({ service: native });
    const github = api.github as CodeModeCapletHandle;

    expect(github.id).toBe("github");
    await github.inspect();
    await github.check();
    await github.tools();
    await github.describeTool("listIssues");
    await expect(github.callTool("listIssues", { state: "open" })).resolves.toMatchObject({
      ok: true,
      data: {
        capletId: "github",
        request: {
          args: { state: "open" },
          operation: "call_tool",
          name: "listIssues",
        },
      },
      meta: { capletId: "github", tool: "listIssues" },
    });

    expect(native.execute).toHaveBeenNthCalledWith(1, "github", { operation: "inspect" });
    expect(native.execute).toHaveBeenNthCalledWith(2, "github", { operation: "check" });
    expect(native.execute).toHaveBeenNthCalledWith(3, "github", { operation: "tools" });
    expect(native.execute).toHaveBeenNthCalledWith(4, "github", {
      operation: "describe_tool",
      name: "listIssues",
    });
    expect(native.execute).toHaveBeenNthCalledWith(5, "github", {
      operation: "call_tool",
      name: "listIssues",
      args: { state: "open" },
    });
  });

  it("treats unavailable backend checks as expected readiness failures", async () => {
    const native = service([
      {
        caplet: "browser",
        toolName: "caplets_browser",
        title: "Browser",
        description: "Browser automation.",
        promptGuidance: [],
      },
    ]);
    vi.mocked(native.execute).mockResolvedValueOnce({
      structuredContent: {
        result: {
          id: "browser",
          status: "unavailable",
          elapsedMs: 21,
          error: {
            code: "SERVER_UNAVAILABLE",
            message: "Browser profile is locked.",
          },
        },
      },
    });
    const api = createCodeModeCapletsApi({ service: native });
    const browser = api.browser as CodeModeCapletHandle;

    await expect(browser.check()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "backend_not_ready",
        message: "browser is unavailable: Browser profile is locked.",
        details: {
          id: "browser",
          status: "unavailable",
          error: {
            code: "SERVER_UNAVAILABLE",
            message: "Browser profile is locked.",
          },
        },
      },
      meta: { capletId: "browser" },
    });
  });

  it("unwraps progressive disclosure results for handle inspection and tool discovery", async () => {
    const native = service([
      {
        caplet: "github",
        toolName: "caplets_github",
        title: "GitHub",
        description: "GitHub repo operations.",
        promptGuidance: [],
      },
    ]);
    vi.mocked(native.execute)
      .mockResolvedValueOnce({
        structuredContent: {
          result: {
            id: "github",
            name: "GitHub",
            description: "GitHub repo operations.",
          },
        },
      })
      .mockResolvedValueOnce({
        structuredContent: {
          result: {
            id: "github",
            name: "GitHub",
            items: [
              {
                name: "get_me",
                description: "Get current user.",
                useWhen: "Use to identify the authenticated user.",
                avoidWhen: "Avoid for repository owner lookup.",
                hasInputSchema: true,
                hasOutputSchema: false,
                supportsFields: false,
                readOnlyHint: true,
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        structuredContent: {
          result: {
            id: "github",
            tool: {
              name: "get_me",
              description: "Get current user.",
              useWhen: "Use to identify the authenticated user.",
              avoidWhen: "Avoid for repository owner lookup.",
              inputSchema: {
                type: "object",
                properties: { owner: { type: "string" }, page: { type: "integer" } },
                required: ["owner"],
                additionalProperties: false,
              },
              outputSchema: {
                type: "object",
                properties: { login: { type: "string" } },
                required: ["login"],
              },
            },
            fieldSelection: { supported: true },
            observedOutputShape: {
              version: 1,
              source: "observed",
              observedAt: "2026-06-08T00:00:00.000Z",
              sampleCount: 1,
              typeScript: "type ObservedOutput = { login?: string; };",
              jsonShape: {
                kind: "object",
                fields: { login: { optional: true, shape: { kind: "string" } } },
              },
              truncated: false,
            },
          },
        },
      });
    const api = createCodeModeCapletsApi({ service: native });
    const github = api.github as CodeModeCapletHandle;

    await expect(github.inspect()).resolves.toMatchObject({ id: "github", name: "GitHub" });
    await expect(github.tools({ limit: 1 })).resolves.toEqual({
      items: [
        {
          name: "get_me",
          description: "Get current user.",
          useWhen: "Use to identify the authenticated user.",
          avoidWhen: "Avoid for repository owner lookup.",
          readOnlyHint: true,
        },
      ],
    });
    const descriptor = await github.describeTool("get_me");
    expect(descriptor).toMatchObject({
      ok: true,
      data: {
        id: "github",
        tool: {
          name: "get_me",
          description: "Get current user.",
          useWhen: "Use to identify the authenticated user.",
          avoidWhen: "Avoid for repository owner lookup.",
        },
        inputSchema: expect.objectContaining({ type: "object" }),
        outputSchema: expect.objectContaining({ type: "object" }),
        callSignature:
          'callTool(name: "get_me", args: GetMeInput): Promise<CapletsResult<GetMeOutput>>',
        inputTypeScript: "type GetMeInput = { owner: string; page?: number; };",
        outputTypeScript: expect.stringContaining("login: string"),
        observedOutputShape: {
          source: "observed",
          typeScript: "type ObservedOutput = { login?: string; };",
        },
        examples: [],
      },
    });
    if (!descriptor.ok) throw new Error("expected descriptor success");
    const tool = (descriptor.data as { tool?: Record<string, unknown> }).tool ?? {};
    expect((descriptor.data as { fieldSelection?: unknown }).fieldSelection).toBeUndefined();
    expect(tool.inputSchema).toBeUndefined();
    expect(tool.outputSchema).toBeUndefined();
    expect(tool.icons).toBeUndefined();
  });

  it("shortens tool summary descriptions without shortening describeTool details", async () => {
    const longDescription = `${"Use this tool to inspect repository issues and pull requests. ".repeat(8)}It remains fully available through describeTool.`;
    const native = service([
      {
        caplet: "github",
        toolName: "caplets_github",
        title: "GitHub",
        description: "GitHub repo operations.",
        promptGuidance: [],
      },
    ]);
    vi.mocked(native.execute)
      .mockResolvedValueOnce({
        structuredContent: {
          result: {
            items: [
              {
                name: "search_issues",
                title: "Search issues",
                description: longDescription,
                readOnlyHint: true,
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        structuredContent: {
          result: {
            tool: {
              name: "search_issues",
              title: "Search issues",
              description: longDescription,
            },
          },
        },
      });
    const api = createCodeModeCapletsApi({ service: native });
    const github = api.github as CodeModeCapletHandle;

    const tools = await github.tools();
    const descriptor = await github.describeTool("search_issues");

    const summary = tools.items[0] as { description?: unknown } | undefined;
    expect(String(summary?.description).length).toBeLessThan(longDescription.length);
    expect(tools.items[0]).toMatchObject({ name: "search_issues", readOnlyHint: true });
    expect(descriptor).toMatchObject({
      ok: true,
      data: { tool: { name: "search_issues", description: longDescription } },
    });
  });

  it("returns expected tool failures as result envelopes", async () => {
    const native = service([
      {
        caplet: "github",
        toolName: "caplets_github",
        title: "GitHub",
        description: "GitHub repo operations.",
        promptGuidance: [],
      },
    ]);
    vi.mocked(native.execute).mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "Bad request." }],
      structuredContent: { errorCode: "request_invalid" },
    });
    const api = createCodeModeCapletsApi({ service: native });
    const github = api.github as CodeModeCapletHandle;

    await expect(github.callTool("listIssues", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "request_invalid", message: "Bad request." },
      meta: { capletId: "github", tool: "listIssues" },
    });
  });

  it("preserves structured error details without double wrapping", async () => {
    const native = service([
      {
        caplet: "github",
        toolName: "caplets_github",
        title: "GitHub",
        description: "GitHub repo operations.",
        promptGuidance: [],
      },
    ]);
    vi.mocked(native.execute).mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "call_tool args are invalid" }],
      structuredContent: {
        error: {
          code: "REQUEST_INVALID",
          message: "call_tool args are invalid",
          details: {
            requiredArgs: ["query"],
            acceptedArgs: ["perPage", "query"],
          },
        },
      },
    });
    const api = createCodeModeCapletsApi({ service: native });
    const github = api.github as CodeModeCapletHandle;

    await expect(github.callTool("search_issues", { q: "repo:o/r" })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "callTool args are invalid",
        details: {
          requiredArgs: ["query"],
          acceptedArgs: ["perPage", "query"],
        },
      },
    });
  });

  it("preserves thrown validation details for Code Mode repair", async () => {
    const native = service([
      {
        caplet: "github",
        toolName: "caplets_github",
        title: "GitHub",
        description: "GitHub repo operations.",
        promptGuidance: [],
      },
    ]);
    vi.mocked(native.execute).mockRejectedValueOnce(
      new CapletsError(
        "REQUEST_INVALID",
        "call_tool args for search_issues are invalid; use search_tools or describe_tool before call_tool.",
        {
          tool: "search_issues",
          schemaErrors: [{ path: "/query", rule: "type", expected: "string" }],
          callSignature:
            'callTool(name: "search_issues", args: SearchIssuesInput): Promise<CapletsResult<SearchIssuesOutput>>',
          retry:
            "Call describe_tool for this tool, then call_tool with args matching inputSchema/inputTypeScript exactly.",
          fallback:
            "If this is not the right tool, use search_tools, read_resource, resource_templates, search_resources, search_prompts, get_prompt, or complete.",
          nested: ["describe_tool", { operation: "call_tool" }],
        },
      ),
    );
    const api = createCodeModeCapletsApi({ service: native });
    const github = api.github as CodeModeCapletHandle;

    const result = await github.callTool("search_issues", { query: 123 });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message:
          "callTool args for search_issues are invalid; use searchTools or describeTool before callTool.",
        details: {
          tool: "search_issues",
          schemaErrors: [{ path: "/query", rule: "type", expected: "string" }],
          retry:
            "Call describeTool for this tool, then callTool with args matching inputSchema/inputTypeScript exactly.",
          fallback:
            "If this is not the right tool, use searchTools, readResource, resourceTemplates, searchResources, searchPrompts, getPrompt, or complete.",
          nested: ["describeTool", { operation: "callTool" }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("call_tool");
    expect(JSON.stringify(result)).not.toContain("describe_tool");
    expect(JSON.stringify(result)).not.toContain("search_tools");
    expect(JSON.stringify(result)).not.toContain("read_resource");
    expect(JSON.stringify(result)).not.toContain("resource_templates");
    expect(JSON.stringify(result)).not.toContain("search_resources");
    expect(JSON.stringify(result)).not.toContain("search_prompts");
    expect(JSON.stringify(result)).not.toContain("get_prompt");
  });

  it("compacts tool call success results to the useful payload", async () => {
    const native = service([
      {
        caplet: "github",
        toolName: "caplets_github",
        title: "GitHub",
        description: "GitHub repo operations.",
        promptGuidance: [],
      },
    ]);
    vi.mocked(native.execute).mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ login: "octocat", id: 1 }) }],
      _meta: {
        caplets: {
          id: "github",
          name: "GitHub",
          backend: "mcp",
          operation: "call_tool",
          tool: "get_me",
          status: "ok",
          elapsedMs: 12,
        },
      },
    });
    const api = createCodeModeCapletsApi({ service: native });
    const github = api.github as CodeModeCapletHandle;

    await expect(github.callTool("get_me", {})).resolves.toEqual({
      ok: true,
      data: { login: "octocat", id: 1 },
      meta: {
        capletId: "github",
        tool: "get_me",
        durationMs: expect.any(Number),
        status: "ok",
        elapsedMs: 12,
      },
    });
  });

  it("unwraps HTTP-style structured bodies for tool call success results", async () => {
    const native = service([
      {
        caplet: "osv",
        toolName: "caplets_osv",
        title: "OSV",
        description: "Open Source Vulnerabilities operations.",
        promptGuidance: [],
      },
    ]);
    vi.mocked(native.execute).mockResolvedValueOnce({
      structuredContent: {
        status: 200,
        statusText: "",
        headers: { "content-type": "application/json" },
        body: {
          vulns: [
            { id: "GHSA-35jh-r3h4-6jhm", aliases: ["CVE-2021-23337"] },
            { id: "GHSA-29mw-wpgm-hmr9", aliases: ["CVE-2020-28500"] },
          ],
        },
      },
      content: [{ type: "text", text: "HTTP 200" }],
    });
    const api = createCodeModeCapletsApi({ service: native });
    const osv = api.osv as CodeModeCapletHandle;

    await expect(
      osv.callTool("query_package_version", {
        name: "lodash",
        ecosystem: "npm",
        version: "4.17.20",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        vulns: [
          { id: "GHSA-35jh-r3h4-6jhm", aliases: ["CVE-2021-23337"] },
          { id: "GHSA-29mw-wpgm-hmr9", aliases: ["CVE-2020-28500"] },
        ],
      },
      meta: { capletId: "osv", tool: "query_package_version" },
    });
  });

  it("does not expose raw MCP transport details in expected tool failures", async () => {
    const native = service([
      {
        caplet: "github",
        toolName: "caplets_github",
        title: "GitHub",
        description: "GitHub repo operations.",
        promptGuidance: [],
      },
    ]);
    vi.mocked(native.execute).mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "missing required parameter: owner" }],
      _meta: {
        caplets: {
          id: "github",
          name: "GitHub",
          backend: "mcp",
          operation: "call_tool",
          tool: "create_branch",
          status: "error",
          elapsedMs: 180,
        },
      },
    });
    const api = createCodeModeCapletsApi({ service: native });
    const github = api.github as CodeModeCapletHandle;
    const result = await github.callTool("create_branch", {});

    expect(result).toEqual({
      ok: false,
      error: {
        code: "tool_call_failed",
        message: "missing required parameter: owner",
      },
      meta: {
        capletId: "github",
        tool: "create_branch",
        durationMs: expect.any(Number),
        status: "error",
        elapsedMs: 180,
      },
    });
    expect(JSON.stringify(result)).not.toContain('"content"');
    expect(JSON.stringify(result)).not.toContain('"_meta"');
  });

  it("adds debug.readLogs without hiding a debug caplet handle", () => {
    const native = service([
      {
        caplet: "debug",
        toolName: "caplets_debug",
        title: "Debug",
        description: "Debug caplet.",
        promptGuidance: [],
      },
    ]);
    const api = createCodeModeCapletsApi({
      service: native,
      readLogs: vi.fn(async () => ({
        entries: [],
      })),
    });
    const debug = api.debug as CodeModeCapletHandle & { readLogs: unknown };

    expect(debug.id).toBe("debug");
    expect(debug.readLogs).toBeTypeOf("function");
    expect(debug.callTool).toBeTypeOf("function");
  });
});
