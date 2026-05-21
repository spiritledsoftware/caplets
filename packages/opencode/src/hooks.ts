import { tool, type Hooks } from "@opencode-ai/plugin";
import { nativeCapletsSystemGuidance, type NativeCapletsService } from "@caplets/core/native";
import { capletsOpenCodeArgs } from "./schema";

export async function createCapletsOpenCodeHooks(service: NativeCapletsService): Promise<Hooks> {
  const capletTools = service.listTools();
  const registeredToolNames = new Set(capletTools.map((caplet) => caplet.toolName));

  return {
    tool: Object.fromEntries(
      capletTools.map((caplet) => [
        caplet.toolName,
        tool({
          description: caplet.description,
          args: capletsOpenCodeArgs(caplet.operationNames ?? undefined),
          async execute(args) {
            const result = await service.execute(caplet.caplet, args);
            return compactOpenCodeResult(result);
          },
        }),
      ]),
    ),
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        nativeCapletsSystemGuidance(
          service
            .listTools()
            .map((caplet) => caplet.toolName)
            .filter((toolName) => registeredToolNames.has(toolName)),
        ),
      );
    },
  };
}

function compactOpenCodeResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return String(result ?? "null");
  }
  const content = (result as Record<string, unknown>).content;
  if (Array.isArray(content)) {
    const text = content
      .filter((item): item is { type: string; text: string } =>
        Boolean(
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string",
        ),
      )
      .map((item) => item.text)
      .join("\n")
      .replace(/\s+/gu, " ")
      .trim();
    if (text) return text.length > 600 ? `${text.slice(0, 599).trimEnd()}…` : text;
  }
  try {
    return JSON.stringify(result, null, 2) ?? "null";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Serialization error: ${message}]`;
  }
}
