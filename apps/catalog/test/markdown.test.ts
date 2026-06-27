import { describe, expect, it } from "vitest";
import { renderCatalogMarkdown, splitCatalogMarkdown } from "../src/lib/markdown";

describe("catalog Markdown rendering", () => {
  it("strips raw HTML and dangerous URLs from indexed content", async () => {
    const html = await renderCatalogMarkdown(
      "# Caplet\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [ok](https://example.com)",
    );

    expect(html).toContain("<h1>Caplet</h1>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
  });

  it("extracts CAPLET frontmatter into flattened table rows", () => {
    const parts = splitCatalogMarkdown(
      [
        "---",
        "# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json",
        "name: ast-grep",
        "tags:",
        "  - mcp",
        "  - code",
        "projectBinding:",
        "  required: true",
        "setup:",
        "  commands:",
        "    - label: Install ast-grep MCP command",
        "      args: [install, -g, ast-grep-mcp]",
        "---",
        "",
        "# ast-grep MCP",
      ].join("\n"),
    );

    expect(parts.bodyMarkdown).toBe("# ast-grep MCP");
    expect(parts.frontmatterRows).toEqual([
      { key: "name", value: "ast-grep" },
      { key: "tags", value: "mcp, code" },
      { key: "projectBinding.required", value: "true" },
      { key: "setup.commands[0].label", value: "Install ast-grep MCP command" },
      { key: "setup.commands[0].args", value: "install, -g, ast-grep-mcp" },
    ]);
  });
});
