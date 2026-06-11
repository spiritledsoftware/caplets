import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types";
import { searchToolList } from "../src/tool-search";

const readOnly = { readOnlyHint: true } as const;
const emptyObjectSchema = { type: "object" as const, properties: {} };

function tool(input: Omit<Tool, "inputSchema">): Tool {
  return { inputSchema: emptyObjectSchema, ...input };
}

describe("searchToolList", () => {
  it("ranks matching tools ahead of generic safe operations", () => {
    const tools: Tool[] = [
      tool({ name: "list", annotations: readOnly }),
      tool({ name: "get", annotations: readOnly }),
      tool({ name: "checks", description: "CI checks for a pull request", annotations: readOnly }),
      tool({ name: "diff", annotations: readOnly }),
    ];

    const result = searchToolList(tools, "ci checks", 3, (tool) => tool.name);

    expect(result).toEqual(["checks"]);
  });

  it("falls back to common safe starter operations when the query has no keyword matches", () => {
    const tools: Tool[] = [
      tool({ name: "diff", annotations: readOnly }),
      tool({ name: "inspect", annotations: readOnly }),
      tool({ name: "get", annotations: readOnly }),
      tool({ name: "search", annotations: readOnly }),
      tool({ name: "list", annotations: readOnly }),
      tool({ name: "delete", annotations: { destructiveHint: true } }),
    ];

    const result = searchToolList(tools, "customer renewal risk", 4, (tool) => tool.name);

    expect(result).toEqual(["search", "list", "get", "diff"]);
  });
});
