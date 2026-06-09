import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_MODE_RUNTIME_API_DECLARATION } from "../src/code-mode/runtime-api.generated";
import {
  codeModeDeclarationHash,
  generateCodeModeDeclarations,
  generateCodeModeRunToolDescription,
  minifyCodeModeDeclarationText,
} from "../src/code-mode/declarations";
import type { CodeModeCallableCaplet } from "../src/code-mode/types";

describe("generateCodeModeDeclarations", () => {
  it("keeps the generated runtime API declaration in sync with the checked template", () => {
    const template = readFileSync(
      join(import.meta.dirname, "../src/code-mode/runtime-api.d.ts"),
      "utf8",
    );

    expect(CODE_MODE_RUNTIME_API_DECLARATION).toBe(minifyCodeModeDeclarationText(template));
  });

  it("declares callable caplets with strict handle ids and compact descriptions", () => {
    const declaration = generateCodeModeDeclarations({
      caplets: [
        {
          id: "github",
          name: "GitHub",
          description: "GitHub repo, issue, PR, workflow ops.",
          useWhen: "Use for repository issue, PR, and workflow tasks.",
          avoidWhen: "Avoid for package vulnerability lookup.",
        },
        {
          id: "build-system",
          name: "Build System",
          description: "Internal build system operations.",
        },
      ],
    });

    expect(declaration).toContain('github:CapletHandle<"github">;');
    expect(declaration).toContain('"build-system":CapletHandle<"build-system">;');
    expect(declaration).toContain(
      "/**GitHub repo, issue, PR, workflow ops. Use when: Use for repository issue, PR, and workflow tasks. Avoid when: Avoid for package vulnerability lookup.*/",
    );
    expect(declaration).toContain("/** Search tool summaries for the discovery pass;");
    expect(declaration).toContain("prefer outputSchema/outputTypeScript over observed hints");
    expect(declaration).toContain("Exact downstream tool identifier");
    expect(declaration).toContain("useWhen?:string");
    expect(declaration).toContain("avoidWhen?:string");
    expect(declaration).toContain("readOnlyHint?:boolean");
    expect(declaration).toContain("destructiveHint?:boolean");
    expect(declaration).toContain("type ToolSummary={");
    expect(declaration).not.toContain("ToolSummary={id?:string");
    expect(declaration).not.toContain("tool?:string;description");
    expect(declaration).toContain("inspect():Promise<CapletCard<Id>>;");
    expect(declaration).toContain(
      "callTool(name:string,args?:unknown):Promise<CapletsResult<unknown>>",
    );
    expect(declaration).toContain("observedOutputShape?:ObservedOutputShape");
    expect(declaration).not.toContain("fieldSelection");
    expect(declaration).toContain("resources(input?:PageInput):Promise<Page<ResourceSummary>>");
    expect(declaration).toContain("readLogs(input:ReadLogsInput):Promise<ReadLogsResult>");
    expect(declaration).not.toContain("\n\n");
    expect(declaration).not.toContain(" = ");
  });

  it("builds the shared Code Mode tool description from generated declarations", () => {
    const declaration = 'declare const caplets:{docs:CapletHandle<"docs">;};';
    const description = generateCodeModeRunToolDescription(declaration);

    expect(description).toContain("Prefer a compact one-pass script for most tasks");
    expect(description).toContain("Do not return full tool lists");
    expect(description).toContain("keep bulky intermediate data inside the script");
    expect(description).toContain("Execute with exact args");
    expect(description).toContain("return only decision-ready JSON");
    expect(description).toContain("For fallback, check candidate handles first");
    expect(description).toContain("const ready=await h.check()");
    expect(description).toContain("Never invent tool names, resource URIs, prompt names");
    expect(description).toContain("when args matter, use describeTool");
    expect(description).toContain("exact callSignature/inputSchema/inputTypeScript");
    expect(description).toContain("Generated declaration hints:");
    expect(description).toContain(declaration);
    expect(description).not.toContain("Do not split discovery and execution");
    expect(description).not.toContain("caplets.github");
    expect(description).not.toContain("search_issues");
  });

  it("uses intersection typing when a callable caplet id collides with debug", () => {
    const declaration = generateCodeModeDeclarations({
      caplets: [
        {
          id: "debug",
          name: "Debug Caplet",
          description: "Debug capability domain.",
        },
      ],
    });

    expect(declaration).toContain('debug:DebugApi&CapletHandle<"debug">;');
    expect(declaration).not.toContain("debug: {");
  });

  it("removes repeated discovery guidance and native metadata from JSDoc hints", () => {
    const declaration = generateCodeModeDeclarations({
      caplets: [
        {
          id: "github",
          name: "GitHub",
          description:
            "GitHub Caplet. Inspect and manage GitHub repositories, issues, pull requests, branches, commits, and code review workflows. Use inspect for details when needed; use tools for actions, resources for readable context, prompts for reusable workflows, and complete for prompt/resource-template arguments. Native tool name: caplets_github Original Caplet ID: github",
        },
      ],
    });

    expect(declaration).toContain(
      "/**GitHub Caplet. Inspect and manage GitHub repositories, issues, pull requests, branches, commits, and code review workflows.*/",
    );
    expect(declaration).not.toContain("Use inspect for details when needed");
    expect(declaration).not.toContain("Native tool name:");
    expect(declaration).not.toContain("Original Caplet ID:");
  });

  it("bounds long JSDoc hints", () => {
    const declaration = generateCodeModeDeclarations({
      caplets: [
        {
          id: "verbose",
          name: "Verbose",
          description: "A".repeat(500),
        },
      ],
    });

    expect(declaration).toContain(`${"A".repeat(177)}...`);
    expect(declaration).not.toContain("A".repeat(181));
  });

  it("returns stable hashes for equivalent declaration content", () => {
    const caplets: CodeModeCallableCaplet[] = [
      { id: "github", name: "GitHub", description: "GitHub repo operations." },
    ];

    const first = codeModeDeclarationHash(generateCodeModeDeclarations({ caplets }));
    const second = codeModeDeclarationHash(generateCodeModeDeclarations({ caplets }));

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
  });
});
