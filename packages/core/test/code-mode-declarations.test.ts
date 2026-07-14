import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_MODE_RUNTIME_API_DECLARATION } from "../src/code-mode/runtime-api.generated";
import {
  codeModeDeclarationHash,
  generateCodeModeDeclarations,
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
    expect(declaration).toContain("/**GitHub repo, issue, PR, workflow ops.*/");
    expect(declaration).not.toContain("\n\n");
    expect(declaration).not.toContain(" = ");
  });

  it("keeps platform globals out of generated declarations", () => {
    const declaration = generateCodeModeDeclarations({
      caplets: [{ id: "github", name: "GitHub", description: "GitHub repo operations." }],
    });

    expect(declaration).toContain("declare const console:Console");
    expect(declaration).not.toContain("declare function atob");
    expect(declaration).not.toContain("declare function btoa");
    expect(declaration).not.toContain("declare const Buffer");
    expect(declaration).not.toContain("declare class URL");
    expect(declaration).not.toContain("declare class TextEncoder");
    expect(declaration).not.toContain("declare const crypto");
    expect(declaration).not.toContain("declare function structuredClone");
    expect(declaration).not.toContain("declare class Headers");
    expect(declaration).not.toContain("declare class Blob");
    expect(declaration).not.toContain("declare class File");
    expect(declaration).not.toContain("declare class FormData");
    expect(declaration).not.toContain("declare class ReadableStream");
    expect(declaration).not.toContain("declare class WritableStream");
    expect(declaration).not.toContain("declare class TransformStream");
    expect(declaration).not.toContain("declare class AbortController");
    expect(declaration).not.toContain("declare class AbortSignal");
    expect(declaration).not.toContain("declare class Request");
    expect(declaration).not.toContain("declare class Response");
    expect(declaration).not.toContain("declare function fetch");
    expect(declaration).not.toContain("declare function queueMicrotask");
    expect(declaration).not.toContain("declare function setTimeout");
    expect(declaration).not.toContain("declare function clearTimeout");
    expect(declaration).not.toContain("declare function setInterval");
    expect(declaration).not.toContain("declare function clearInterval");
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
            "GitHub Caplet. Inspect and manage GitHub repositories, issues, pull requests, branches, commits, and code review workflows. Use inspect for details when needed; use tools for actions, resources for readable context, prompts for reusable workflows, and complete for prompt/resource-template arguments. Native tool name: caplets__github Original Caplet ID: github",
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

    expect(declaration).toContain(`${"A".repeat(237)}...`);
    expect(declaration).not.toContain("A".repeat(241));
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
