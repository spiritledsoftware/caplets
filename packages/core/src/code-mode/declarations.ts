import type { CodeModeDeclarationInput } from "./types";
import { CODE_MODE_RUNTIME_API_DECLARATION } from "./runtime-api.generated";

const JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const MAX_JSDOC_CHARS = 180;

export function generateCodeModeDeclarations(input: CodeModeDeclarationInput): string {
  const caplets = [...input.caplets].sort((left, right) => left.id.localeCompare(right.id));
  const properties = caplets.map((caplet) => {
    const key = propertyKey(caplet.id);
    const description = jsDoc(capletHintText(caplet));
    if (caplet.id === "debug") {
      return `${description}debug:DebugApi&CapletHandle<"debug">;`;
    }
    return `${description}${key}:CapletHandle<${JSON.stringify(caplet.id)}>;`;
  });
  if (!caplets.some((caplet) => caplet.id === "debug")) {
    properties.push("debug:DebugApi;");
  }

  return ["declare const caplets:{", ...properties, "};", CODE_MODE_RUNTIME_API_DECLARATION].join(
    "\n",
  );
}

export function generateCodeModeRunToolDescription(declaration: string): string {
  return [
    'Run TypeScript with generated `caplets.<id>` handles and declaration hints below. Prefer a two-pass workflow for non-trivial tasks. Pass 1: discover and inspect candidate caplets/tools/resources/prompts with inspect, check, tools/searchTools, describeTool, resources/searchResources, and prompts/searchPrompts; return chosen handles, call signatures/schemas, and planned args. Never invent tool names, resource URIs, prompt names, input args, output fields, or schemas. Never infer input/output schemas from memory; use describeTool for the exact callSignature, inputSchema/inputTypeScript, outputSchema/outputTypeScript, examples, and observedOutputShape. For fallback, check candidate handles first: `for(const h of candidates){const ready=await h.check();if(!ready.ok)continue;}`. Pass 2: execute with exact args, handle `{ok:false}`, filter bulky results, and synthesize compact JSON. Return decision-ready JSON, not raw tool payloads: reduce tool results to summary, key evidence, derived fields, recommendation, and caveats; derive final recommendations from all relevant records, not the first matching record; if records disagree or have ranges/statuses, compute the strictest applicable conclusion and preserve the evidence used. Before `callTool`, use `describeTool` and pass args with exact `inputTypeScript`/`inputSchema` property names; do not guess from provider memory. For triage, list broad candidate records and filter in script before targeted searches so adjacent relevant items are not missed. For result shape, prefer `outputSchema` or `outputTypeScript`; use `observedOutputShape` only when those are absent or generic. Filter bulky results in script before returning, while preserving useful identifiers/links such as id,name,title,state,status,url,html_url,labels,created_at,updated_at. Pattern: discovery `const h=caplets["caplet-id"];const d=await h.describeTool("tool_name");return {caplet:h.id,tool:"tool_name",descriptor:d};` then execution `const h=caplets["caplet-id"];const r=await h.callTool("tool_name",args);if(!r.ok)return {error:r.error};return /* compact JSON */;`',
    "",
    "Generated declaration hints:",
    "```ts",
    declaration,
    "```",
  ].join("\n");
}

function capletHintText(caplet: CodeModeDeclarationInput["caplets"][number]): string {
  return [
    caplet.description || caplet.name || caplet.id,
    caplet.useWhen ? `Use when: ${caplet.useWhen}` : undefined,
    caplet.avoidWhen ? `Avoid when: ${caplet.avoidWhen}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

export function minifyCodeModeDeclarationText(value: string): string {
  return value
    .replace(/^\s*export\s*\{\s*\}\s*;?\s*/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .replace(/\s*([{}()[\]:;,|&=])\s*/gu, "$1")
    .replace(/\s*<\s*/gu, "<")
    .replace(/\s*>\s*/gu, ">")
    .replace(/\?\s*:/gu, "?:")
    .trim();
}

export function codeModeDeclarationHash(declaration: string): string {
  return [
    fnv1a32(declaration, 0x811c9dc5),
    fnv1a32(declaration, 0x9e3779b9),
    fnv1a32(declaration, 0x85ebca6b),
    fnv1a32(declaration, 0xc2b2ae35),
    fnv1a32(declaration, 0x27d4eb2f),
    fnv1a32(declaration, 0x165667b1),
    fnv1a32(declaration, 0xd3a2646c),
    fnv1a32(declaration, 0xfd7046c5),
  ]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
}

function propertyKey(id: string): string {
  return JS_IDENTIFIER.test(id) ? id : JSON.stringify(id);
}

function jsDoc(value: string): string {
  return `/**${compactJsDoc(value)}*/`;
}

function sanitizeJsDoc(value: string): string {
  return value.replace(/\*\//gu, "* /").replace(/\s+/gu, " ").trim();
}

function compactJsDoc(value: string): string {
  const cleaned = sanitizeJsDoc(value);
  const markers = [
    " Use inspect for details when needed;",
    " Native tool name:",
    " Original Caplet ID:",
  ];
  const cutoff = markers
    .map((marker) => cleaned.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const summary = (cutoff === undefined ? cleaned : cleaned.slice(0, cutoff).trim()) || "Caplet.";
  if (summary.length <= MAX_JSDOC_CHARS) return summary;
  const sentenceEnd = summary.lastIndexOf(".", MAX_JSDOC_CHARS);
  if (sentenceEnd >= 40) return summary.slice(0, sentenceEnd + 1);
  return `${summary.slice(0, MAX_JSDOC_CHARS - 3).trimEnd()}...`;
}

function fnv1a32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
