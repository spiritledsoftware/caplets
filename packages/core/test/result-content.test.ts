import { describe, expect, it } from "vitest";
import {
  compactCallToolResultContent,
  compactJsonText,
  hasRenderableStructuredContent,
  markdownCallToolResultContent,
  markdownStructuredContent,
} from "../src/result-content";

describe("result content helpers", () => {
  it("compacts undefined JSON values without throwing", () => {
    expect(compactJsonText(undefined)).toBe("undefined");
  });

  it("renders HTTP response body as complete Markdown", () => {
    const text = compactCallToolResultContent({
      content: [],
      structuredContent: {
        status: 200,
        statusText: "OK",
        body: { vulns: [] },
        elapsedMs: 12,
      },
    })[0]?.text;

    expect(text).toContain("# Result");
    expect(text).toContain("## Response");
    expect(text).toContain("- **Status:** `200 OK`");
    expect(text).toContain("- **Elapsed:** `12 ms`");
    expect(text).toContain("## Body");
    expect(text).toContain('"vulns": []');
  });

  it("renders GraphQL body data and full body", () => {
    const text = markdownStructuredContent(
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: { data: { viewer: { login: "octocat" } } },
      },
      { title: "GitHub GraphQL call_tool viewer", backend: "graphql" },
    )[0]?.text;

    expect(text).toContain("# GitHub GraphQL call_tool viewer");
    expect(text).toContain("## Data");
    expect(text).toContain('"viewer": {');
    expect(text).toContain("## Full Body");
  });

  it("renders CLI stdout stderr and parsed JSON", () => {
    const text = markdownStructuredContent(
      {
        exitCode: 0,
        stdout: '{"matches":[]}',
        stderr: "",
        elapsedMs: 52,
        json: { matches: [] },
      },
      { title: "Repo CLI call_tool search", backend: "cli" },
    )[0]?.text;

    expect(text).toContain("# Repo CLI call_tool search");
    expect(text).toContain("## Command Result");
    expect(text).toContain("- **Exit code:** `0`");
    expect(text).toContain("## stdout");
    expect(text).toContain('{"matches":[]}');
    expect(text).toContain("## stderr\n\n_No stderr._");
    expect(text).toContain("## Parsed JSON");
    expect(text).toContain('"matches": []');
  });

  it("preserves mixed downstream MCP blocks in order without adding structured-content prose", () => {
    const downstreamContent = [
      { type: "text", text: "Downstream text" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "resource_link", uri: "file:///tmp/report.pdf", name: "Report" },
    ];
    const content = markdownCallToolResultContent(
      {
        content: downstreamContent,
        structuredContent: { snapshot: { title: "Example" } },
        isError: true,
      },
      { title: "Browser call_tool browser_snapshot", backend: "mcp" },
    );

    expect(content).toEqual(downstreamContent);
    expect(content).toHaveLength(3);
  });

  it("detects renderable structured content while ignoring metadata-only objects", () => {
    expect(hasRenderableStructuredContent({ body: { ok: true } })).toBe(true);
    expect(hasRenderableStructuredContent({ caplets: { status: "ok" } })).toBe(false);
    expect(hasRenderableStructuredContent(undefined)).toBe(false);
  });
});
