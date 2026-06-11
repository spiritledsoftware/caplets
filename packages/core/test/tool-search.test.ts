import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types";
import { searchToolList } from "../src/tool-search";

const readOnly = { readOnlyHint: true } as const;

describe("searchToolList", () => {
  it("ranks matching tools ahead of generic safe operations", () => {
    const tools: Tool[] = [
      { name: "list", annotations: readOnly },
      { name: "get", annotations: readOnly },
      { name: "checks", description: "CI checks for a pull request", annotations: readOnly },
      { name: "diff", annotations: readOnly },
    ];

    const result = searchToolList(tools, "ci checks", 3, (tool) => tool.name);

    expect(result).toEqual(["checks"]);
  });

  it("falls back to common safe starter operations when the query has no keyword matches", () => {
    const tools: Tool[] = [
      { name: "diff", annotations: readOnly },
      { name: "inspect", annotations: readOnly },
      { name: "get", annotations: readOnly },
      { name: "search", annotations: readOnly },
      { name: "list", annotations: readOnly },
      { name: "delete", annotations: { destructiveHint: true } },
    ];

    const result = searchToolList(tools, "customer renewal risk", 4, (tool) => tool.name);

    expect(result).toEqual(["search", "list", "get", "diff"]);
  });
});
