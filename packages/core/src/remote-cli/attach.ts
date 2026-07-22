import { CapletsError } from "../errors";
import type { AttachManifest } from "../attach/api";
import type { RemoteCapletsClient, RemoteCapletsTool } from "../native/remote";
import type { RemoteCliArguments, RemoteCliCommand } from "./types";

export type RemoteAttachCommandAdapter = {
  request(command: RemoteCliCommand, args: RemoteCliArguments): Promise<unknown>;
};

/** Routes the runtime-authoritative remote CLI commands through the native Attach client. */
export function createRemoteAttachCommandAdapter(options: {
  client: RemoteCapletsClient;
}): RemoteAttachCommandAdapter {
  return {
    async request(command, args) {
      if (command === "list") {
        return capletRowsFromTools(await options.client.listTools());
      }
      if (command === "complete_cli") {
        return completionSuggestions(await options.client.listTools(), args);
      }
      if (isProgressiveRuntimeCommand(command)) {
        const caplet = typeof args.caplet === "string" ? args.caplet : "";
        if (!caplet || !isRecord(args.request)) {
          throw new CapletsError(
            "REQUEST_INVALID",
            `Remote ${command} requires a Caplet ID and runtime request.`,
          );
        }
        return await options.client.callTool(caplet, args.request);
      }
      throw new CapletsError(
        "UNKNOWN_OPERATION",
        `Remote command ${command} is not an Attach operation.`,
      );
    },
  };
}

export function capletRowsFromAttachManifest(
  manifest: AttachManifest,
): Array<Record<string, unknown>> {
  return capletRows(
    [...manifest.caplets, ...manifest.tools].map((entry) => ({
      id: entry.capletId,
      title: entry.title,
      description: entry.description,
    })),
  );
}

export function completionSuggestionsFromAttachManifest(
  manifest: AttachManifest,
  args: RemoteCliArguments,
): string[] {
  return completionSuggestionsFromValues(
    [
      ...manifest.caplets.map((entry) => entry.name),
      ...manifest.caplets.map((entry) => `${entry.capletId}.check`),
      ...manifest.tools.map((entry) => entry.name),
    ],
    [...manifest.caplets, ...manifest.tools].map((entry) => entry.capletId),
    args,
  );
}

function capletRowsFromTools(tools: RemoteCapletsTool[]): Array<Record<string, unknown>> {
  return capletRows(
    tools.flatMap((tool) => {
      const id = tool.capletId?.trim();
      return id ? [{ id, title: tool.title, description: tool.description }] : [];
    }),
  );
}

function completionSuggestions(tools: RemoteCapletsTool[], args: RemoteCliArguments): string[] {
  return completionSuggestionsFromValues(
    tools.map((tool) => tool.name),
    tools.flatMap((tool) => (tool.capletId ? [tool.capletId] : [])),
    args,
  );
}

function capletRows(
  entries: Array<{ id: string; title?: string | undefined; description?: string | undefined }>,
): Array<Record<string, unknown>> {
  const caplets = new Map<
    string,
    { title?: string | undefined; description?: string | undefined }
  >();
  for (const entry of entries) {
    const id = entry.id.trim();
    if (!id || id === "caplets_code_mode" || caplets.has(id)) continue;
    caplets.set(id, entry);
  }
  return [...caplets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, entry]) => ({
      server: id,
      backend: "attach",
      name: entry.title ?? id,
      ...(entry.description ? { description: entry.description } : {}),
      disabled: false,
      status: "not_started",
      source: "remote-attach",
      path: null,
      shadows: [],
    }));
}

function completionSuggestionsFromValues(
  toolNames: string[],
  capletIds: string[],
  args: RemoteCliArguments,
): string[] {
  const words = Array.isArray(args.words)
    ? args.words.filter((word): word is string => typeof word === "string")
    : [];
  const current = words.at(-1) ?? "";
  const command = words[0] ?? "";
  const values = command === "call-tool" ? toolNames : capletIds;
  return [...new Set(values)].filter((value) => value.startsWith(current)).sort();
}

function isProgressiveRuntimeCommand(command: RemoteCliCommand): boolean {
  return (
    command === "inspect" ||
    command === "check" ||
    command === "tools" ||
    command === "search_tools" ||
    command === "describe_tool" ||
    command === "call_tool" ||
    command === "resources" ||
    command === "search_resources" ||
    command === "resource_templates" ||
    command === "read_resource" ||
    command === "prompts" ||
    command === "search_prompts" ||
    command === "get_prompt" ||
    command === "complete"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
