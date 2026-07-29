import type { CodeModeDeclarationInput } from "./types";
import { CODE_MODE_RUNTIME_API_DECLARATION } from "./runtime-api.generated";

const JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const MAX_JSDOC_CHARS = 240;
const CODE_MODE_REPL_GUIDANCE =
  "Sessions: omit `sessionId` to create one; reuse returned `meta.sessionId`. Sessions preserve top-level declarations and completed mutations; unknown or incompatible IDs fail before execution. `meta.recoveryRef` is audit-only via `caplets.debug.readRecovery({ recoveryRef })`; never auto-replay.";

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
  const handles = declaration.endsWith(CODE_MODE_RUNTIME_API_DECLARATION)
    ? declaration.slice(0, -CODE_MODE_RUNTIME_API_DECLARATION.length).trimEnd()
    : declaration;
  return [
    "Run TypeScript with generated `caplets.<id>` handles. Prefer one compact call that discovers, filters, executes, joins, and returns decision-ready JSON; keep bulky data inside. Use tools/searchTools for names and hints, describeTool for exact or nested schemas. Never guess names, URIs, args, fields, or schemas. Check fallback handles and `{ok:false}`; synthesize all relevant records with evidence and caveats.",
    CODE_MODE_REPL_GUIDANCE,
    "Handles: inspect/check; tools/searchTools/describeTool/callTool; resources/searchResources/resourceTemplates/readResource; prompts/searchPrompts/getPrompt/complete. Lists: {items,nextCursor?,truncated?}. Operations: {ok:true,data,meta?}|{ok:false,error,meta?}. Debug: readLogs/readRecovery.",
    "",
    "Generated handles:",
    "```ts",
    handles,
    "```",
  ].join("\n");
}

function capletHintText(caplet: CodeModeDeclarationInput["caplets"][number]): string {
  return boundedSummary(
    compactCapletField(caplet.description || caplet.name || caplet.id),
    MAX_JSDOC_CHARS,
  );
}

export function minifyCodeModeDeclarationText(value: string): string {
  return value
    .replace(/^\s*export\s*\{\s*\}\s*;?\s*/u, "")
    .replace(/\s*export\s*\{\s*\}\s*;?\s*$/u, "")
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
  return boundedSummary(compactCapletField(value), MAX_JSDOC_CHARS) || "Caplet.";
}

function compactCapletField(value: string): string {
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
  return (cutoff === undefined ? cleaned : cleaned.slice(0, cutoff).trim()) || "Caplet.";
}

function boundedSummary(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const sentenceEnd = value.lastIndexOf(".", limit);
  if (sentenceEnd >= Math.min(40, limit / 2)) return value.slice(0, sentenceEnd + 1);
  return `${value.slice(0, limit - 3).trimEnd()}...`;
}

function fnv1a32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
