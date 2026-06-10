export type TextContentBlock = { type: "text"; text: string };

type ContentBlockLike = { type: string; text?: string } & Record<string, unknown>;

type CallToolResultLike = {
  content?: ContentBlockLike[];
  structuredContent?: unknown;
  isError?: boolean | undefined;
};

export type ResultMarkdownContext = {
  title?: string | undefined;
  backend?: string | undefined;
  operation?: string | undefined;
  tool?: string | undefined;
  uri?: string | undefined;
  prompt?: string | undefined;
  fields?: string[] | undefined;
  isError?: boolean | undefined;
};

export function structuredOnlyContent(): [] {
  return [];
}

export function textContent(text: string): TextContentBlock[] {
  return text ? [{ type: "text", text }] : [];
}

export function compactJsonText(value: unknown, maxLength = 600): string {
  return compactText(JSON.stringify(value) ?? String(value), maxLength);
}

export function compactText(value: string, maxLength = 600): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…`
    : collapsed;
}

export function markdownStructuredContent(
  value: unknown,
  context: ResultMarkdownContext = {},
): TextContentBlock[] {
  return textContent(renderStructuredMarkdown(value, context));
}

export function markdownCallToolResultContent(
  result: CallToolResultLike,
  context: ResultMarkdownContext = {},
): TextContentBlock[] {
  const downstreamText = textBlocksToString(result.content);
  const structuredContent = result.structuredContent;
  const hasStructured = hasRenderableStructuredContent(structuredContent);

  if (context.backend === "mcp" && hasStructured) {
    const renderedStructured = markdownStructuredContent(structuredContent, context)[0]?.text;
    if (downstreamText && downstreamText === renderedStructured) {
      return textContent(downstreamText);
    }
    return [
      ...(result.content ?? []),
      {
        type: "text",
        text: ["## Structured Content", "", jsonFence(structuredContent)].join("\n"),
      },
    ] as TextContentBlock[];
  }

  if (hasStructured) {
    return markdownStructuredContent(structuredContent, {
      ...context,
      isError: context.isError ?? result.isError,
    });
  }

  if (downstreamText) {
    return textContent(downstreamText);
  }

  return textContent(renderStructuredMarkdown(result, context));
}

export function compactStructuredContent(
  value: unknown,
  context: ResultMarkdownContext = {},
): TextContentBlock[] {
  return markdownStructuredContent(value, context);
}

export function compactCallToolResultContent(
  result: CallToolResultLike,
  context: ResultMarkdownContext = {},
): TextContentBlock[] {
  return markdownCallToolResultContent(result, context);
}

export function hasRenderableStructuredContent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.keys(value).some((key) => key !== "caplets" && key !== "elapsedMs");
}

export function byteLimitHint(maxBytes: number): string {
  return `response body limit ${maxBytes} bytes`;
}

function renderStructuredMarkdown(value: unknown, context: ResultMarkdownContext): string {
  const title = markdownTitle(context);
  if (isDiscoveryWrapper(value)) return renderDiscoveryWrapper(value, context, title);
  if (context.isError || isErrorStructuredContent(value)) return renderErrorMarkdown(value, title);
  if (context.backend === "cli" || isCliResult(value)) return renderCliMarkdown(value, title);
  if ((context.backend === "graphql" && isHttpLikeResult(value)) || isGraphQlHttpResult(value)) {
    return renderGraphQlMarkdown(value, title);
  }
  if (isHttpLikeResult(value)) {
    return renderHttpMarkdown(value, title);
  }
  return [title, "", "## Result", "", jsonFence(value)].join("\n");
}

function markdownTitle(context: ResultMarkdownContext): string {
  if (context.title) return `# ${context.title}`;
  const parts = [context.operation, context.tool ?? context.uri ?? context.prompt].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? `# ${parts.join(" ")}` : "# Result";
}

function renderHttpMarkdown(value: unknown, title: string): string {
  const record = asRecord(value) ?? {};
  const lines = [title, "", "## Response", ""];
  const status = typeof record.status === "number" ? record.status : undefined;
  const statusText = typeof record.statusText === "string" ? record.statusText : undefined;
  if (status !== undefined || statusText)
    lines.push(`- **Status:** \`${[status, statusText].filter(Boolean).join(" ")}\``);
  if (typeof record.elapsedMs === "number") lines.push(`- **Elapsed:** \`${record.elapsedMs} ms\``);
  lines.push(
    "",
    "## Headers",
    "",
    jsonFence(record.headers ?? {}),
    "",
    "## Body",
    "",
    renderBodyValue(record.body),
  );
  const additional = omitKeys(record, ["status", "statusText", "headers", "body", "elapsedMs"]);
  if (Object.keys(additional).length > 0)
    lines.push("", "## Additional Fields", "", jsonFence(additional));
  return lines.join("\n");
}

function renderGraphQlMarkdown(value: unknown, title: string): string {
  const record = asRecord(value) ?? {};
  const body = asRecord(record.body);
  if (!body || (!("data" in body) && !("errors" in body))) return renderHttpMarkdown(value, title);
  const lines = [title, "", "## Response", ""];
  const status = typeof record.status === "number" ? record.status : undefined;
  const statusText = typeof record.statusText === "string" ? record.statusText : undefined;
  if (status !== undefined || statusText)
    lines.push(`- **Status:** \`${[status, statusText].filter(Boolean).join(" ")}\``);
  if (typeof record.elapsedMs === "number") lines.push(`- **Elapsed:** \`${record.elapsedMs} ms\``);
  if ("data" in body) lines.push("", "## Data", "", jsonFence(body.data));
  if ("errors" in body) lines.push("", "## Errors", "", jsonFence(body.errors));
  lines.push(
    "",
    "## Headers",
    "",
    jsonFence(record.headers ?? {}),
    "",
    "## Full Body",
    "",
    jsonFence(record.body),
  );
  const additional = omitKeys(record, ["status", "statusText", "headers", "body", "elapsedMs"]);
  if (Object.keys(additional).length > 0)
    lines.push("", "## Additional Fields", "", jsonFence(additional));
  return lines.join("\n");
}

function renderCliMarkdown(value: unknown, title: string): string {
  const record = asRecord(value) ?? {};
  const lines = [title, "", "## Command Result", ""];
  if ("exitCode" in record) lines.push(`- **Exit code:** \`${String(record.exitCode)}\``);
  if ("signal" in record) lines.push(`- **Signal:** \`${String(record.signal)}\``);
  if (typeof record.elapsedMs === "number") lines.push(`- **Elapsed:** \`${record.elapsedMs} ms\``);
  lines.push("", "## stdout", "", textFenceOrEmpty(record.stdout, "No stdout."));
  lines.push("", "## stderr", "", textFenceOrEmpty(record.stderr, "No stderr."));
  if ("json" in record) lines.push("", "## Parsed JSON", "", jsonFence(record.json));
  if ("jsonParseError" in record)
    lines.push("", "## JSON Parse Error", "", jsonFence(record.jsonParseError));
  const additional = omitKeys(record, [
    "exitCode",
    "signal",
    "stdout",
    "stderr",
    "elapsedMs",
    "json",
    "jsonParseError",
  ]);
  if (Object.keys(additional).length > 0)
    lines.push("", "## Additional Fields", "", jsonFence(additional));
  return lines.join("\n");
}

function renderDiscoveryWrapper(
  value: { result: unknown; caplets?: unknown },
  context: ResultMarkdownContext,
  title: string,
): string {
  const result = asRecord(value.result);
  const lines = [title, ""];
  let renderedKnownWrapper = true;
  if (context.operation === "tools" || context.operation === "search_tools") {
    lines.push(
      "## Tools",
      "",
      renderNamedList(arrayValue(result?.items ?? result?.tools), "tool"),
      "",
    );
  } else if (context.operation === "resources" || context.operation === "search_resources") {
    lines.push(
      "## Resources",
      "",
      renderNamedList(arrayValue(result?.items ?? result?.resources ?? result?.matches), "uri"),
      "",
    );
  } else if (context.operation === "resource_templates") {
    lines.push(
      "## Resource Templates",
      "",
      renderNamedList(arrayValue(result?.items ?? result?.resourceTemplates), "uriTemplate"),
      "",
    );
  } else if (context.operation === "prompts" || context.operation === "search_prompts") {
    lines.push(
      "## Prompts",
      "",
      renderNamedList(arrayValue(result?.items ?? result?.prompts), "prompt"),
      "",
    );
  } else if (context.operation === "describe_tool") {
    lines.push("## Tool", "", renderToolSummary(asRecord(result?.tool)), "");
  } else if (context.operation === "check") {
    lines.push("## Backend Status", "", renderBackendStatus(result), "");
  } else if (context.operation === "inspect") {
    lines.push("## Caplet", "", renderCapletSummary(result), "");
  } else {
    renderedKnownWrapper = false;
  }
  if (renderedKnownWrapper) {
    lines.push("Structured result is available in `structuredContent.result`.");
  } else {
    lines.push("## Full Result", "", jsonFence(value.result));
  }
  if (!renderedKnownWrapper && value.caplets !== undefined)
    lines.push("", "## Caplets Metadata", "", jsonFence(value.caplets));
  return lines.join("\n");
}

function renderErrorMarkdown(value: unknown, title: string): string {
  const error = asRecord(asRecord(value)?.error) ?? asRecord(value);
  const code = typeof error?.code === "string" ? error.code : "Error";
  const message = typeof error?.message === "string" ? error.message : "Tool call failed.";
  return [
    title === "# Result" || title === "# Error" ? "# Error" : title,
    "",
    `## ${code}`,
    "",
    message,
    "",
    "## Details",
    "",
    jsonFence(error ?? value),
  ].join("\n");
}

function isDiscoveryWrapper(value: unknown): value is { result: unknown; caplets?: unknown } {
  return isRecord(value) && "result" in value;
}
function isErrorStructuredContent(value: unknown): boolean {
  return isRecord(value) && "error" in value;
}
function isHttpLikeResult(value: unknown): boolean {
  return isRecord(value) && ("status" in value || "statusText" in value || "body" in value);
}
function isGraphQlHttpResult(value: unknown): boolean {
  if (!isHttpLikeResult(value)) return false;
  const body = asRecord((value as Record<string, unknown>).body);
  return Boolean(body && ("data" in body || "errors" in body));
}
function isCliResult(value: unknown): boolean {
  return isRecord(value) && ("exitCode" in value || "stdout" in value || "stderr" in value);
}
function renderBodyValue(value: unknown): string {
  if (value === undefined) return "_No response body._";
  if (typeof value === "string") return textFenceOrEmpty(value, "No response body.");
  return jsonFence(value);
}
function textFenceOrEmpty(value: unknown, emptyMessage: string): string {
  if (typeof value !== "string" || value.length === 0) return `_${emptyMessage}_`;
  return ["```text", escapeCodeFence(value), "```"].join("\n");
}
function jsonFence(value: unknown): string {
  return ["```json", escapeCodeFence(JSON.stringify(value, null, 2) ?? "null"), "```"].join("\n");
}
function escapeCodeFence(value: string): string {
  return value.replace(/```/gu, "`\u200b``");
}
function textBlocksToString(content: CallToolResultLike["content"] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is ContentBlockLike & { type: "text"; text: string } =>
      Boolean(
        item && typeof item === "object" && item.type === "text" && typeof item.text === "string",
      ),
    )
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n");
}
function renderNamedList(items: unknown[], nameKey: string): string {
  if (items.length === 0) return "_No items._";
  return items
    .map((item, index) => {
      const record = asRecord(item);
      const name =
        stringValue(record?.[nameKey]) ?? stringValue(record?.name) ?? `Item ${index + 1}`;
      const description = stringValue(record?.description);
      const hints = compactListHints(record);
      const suffix = [description, hints].filter(Boolean).join("; ");
      return suffix ? `${index + 1}. \`${name}\` — ${suffix}` : `${index + 1}. \`${name}\``;
    })
    .join("\n");
}
function compactListHints(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  const hints: string[] = [];
  const requiredArgs = stringArrayValue(record.requiredArgs);
  const acceptedArgs = stringArrayValue(record.acceptedArgs);
  if (requiredArgs.length > 0) {
    hints.push(`required args: ${requiredArgs.join(", ")}`);
  } else if (acceptedArgs.length > 0) {
    hints.push(`args: ${acceptedArgs.join(", ")}`);
  }
  if (record.supportsFields === true) hints.push("supports fields");
  if (record.readOnlyHint === true) hints.push("read-only");
  if (record.destructiveHint === true) hints.push("destructive");
  const useWhen = stringValue(record.useWhen);
  if (useWhen) hints.push(`use: ${useWhen}`);
  const avoidWhen = stringValue(record.avoidWhen);
  if (avoidWhen) hints.push(`avoid: ${avoidWhen}`);
  return hints.length > 0 ? hints.join("; ") : undefined;
}
function renderToolSummary(tool: Record<string, unknown> | undefined): string {
  if (!tool) return "_Tool details unavailable._";
  const lines: string[] = [];
  const name = stringValue(tool.name);
  const description = stringValue(tool.description);
  if (name) lines.push(`- **Name:** \`${name}\``);
  if (description) lines.push(`- **Description:** ${description}`);
  if (tool.inputSchema !== undefined)
    lines.push("", "### Input Schema", "", jsonFence(tool.inputSchema));
  if (tool.outputSchema !== undefined)
    lines.push("", "### Output Schema", "", jsonFence(tool.outputSchema));
  if (tool.annotations !== undefined)
    lines.push("", "### Annotations", "", jsonFence(tool.annotations));
  return lines.length > 0 ? lines.join("\n") : jsonFence(tool);
}
function renderBackendStatus(result: Record<string, unknown> | undefined): string {
  if (!result) return "_Backend status unavailable._";
  const lines: string[] = [];
  for (const key of [
    "id",
    "status",
    "toolCount",
    "resourceCount",
    "resourceTemplateCount",
    "promptCount",
    "elapsedMs",
  ]) {
    if (result[key] !== undefined) {
      const label = key === "elapsedMs" ? "Elapsed" : humanizeKey(key);
      const suffix = key === "elapsedMs" ? " ms" : "";
      lines.push(`- **${label}:** \`${String(result[key])}${suffix}\``);
    }
  }
  if (result.error !== undefined) lines.push("", "### Error", "", jsonFence(result.error));
  return lines.length > 0 ? lines.join("\n") : jsonFence(result);
}
function renderCapletSummary(result: Record<string, unknown> | undefined): string {
  if (!result) return "_Caplet details unavailable._";
  const lines: string[] = [];
  for (const key of ["id", "name", "description"])
    if (result[key] !== undefined) lines.push(`- **${humanizeKey(key)}:** ${String(result[key])}`);
  const backend = asRecord(result.backend);
  if (backend?.type !== undefined) lines.push(`- **Backend:** \`${String(backend.type)}\``);
  return lines.length > 0 ? lines.join("\n") : jsonFence(result);
}
function omitKeys(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !omitted.has(key)));
}
function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}
function humanizeKey(key: string): string {
  return key.replace(/([A-Z])/gu, " $1").replace(/^./u, (char) => char.toUpperCase());
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
