import type { CapletConfig, RuntimeFeature } from "../config-runtime";
import type { RuntimeFeatureProvenance } from "./types";

export type RuntimeFeatureInference = {
  features: RuntimeFeature[];
  provenance: RuntimeFeatureProvenance[];
};

type CommandSource = RuntimeFeatureProvenance["source"];

type CommandRecord = {
  source: CommandSource;
  command: string;
  args: string[];
};

export function inferRuntimeFeatures(
  caplet: CapletConfig | Record<string, unknown>,
): RuntimeFeatureInference {
  const provenance: RuntimeFeatureProvenance[] = [];
  for (const feature of explicitFeatures(caplet)) {
    provenance.push({ feature, source: "explicit", matched: "runtime.features" });
  }
  for (const command of commandRecords(caplet)) {
    const text = [command.command, ...command.args].join(" ");
    const dockerMatch = matchDocker(command.command, command.args);
    if (dockerMatch) {
      provenance.push({
        feature: "docker",
        source: command.source,
        matched: dockerMatch,
        command: text,
      });
    }
    const browserMatch = matchBrowser(command.command, command.args);
    if (browserMatch) {
      provenance.push({
        feature: "browser",
        source: command.source,
        matched: browserMatch,
        command: text,
      });
    }
  }
  return {
    features: orderedFeatures([...new Set(provenance.map((entry) => entry.feature))]),
    provenance,
  };
}

function explicitFeatures(caplet: Record<string, unknown>): RuntimeFeature[] {
  const runtime = caplet.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return [];
  const features = (runtime as { features?: unknown }).features;
  return Array.isArray(features)
    ? features.filter(
        (feature): feature is RuntimeFeature => feature === "docker" || feature === "browser",
      )
    : [];
}

function commandRecords(caplet: Record<string, unknown>): CommandRecord[] {
  return [
    ...setupCommands(caplet.setup, "setup.commands"),
    ...setupCommands(caplet.setup, "setup.verify", true),
    ...mcpCommands(caplet),
    ...cliCommands(caplet),
  ];
}

function setupCommands(setup: unknown, source: CommandSource, verify = false): CommandRecord[] {
  if (!setup || typeof setup !== "object" || Array.isArray(setup)) return [];
  const values = (setup as { commands?: unknown; verify?: unknown })[
    verify ? "verify" : "commands"
  ];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => commandRecordFrom(value, source));
}

function mcpCommands(caplet: Record<string, unknown>): CommandRecord[] {
  if (caplet.backend !== "mcp" || typeof caplet.command !== "string") return [];
  return [{ source: "mcp.command", command: caplet.command, args: stringArray(caplet.args) }];
}

function cliCommands(caplet: Record<string, unknown>): CommandRecord[] {
  if (caplet.backend !== "cli") return [];
  const records: CommandRecord[] = [];
  if (typeof caplet.command === "string") {
    records.push({
      source: "cli.command",
      command: caplet.command,
      args: stringArray(caplet.args),
    });
  }
  const actions = caplet.actions;
  if (actions && typeof actions === "object" && !Array.isArray(actions)) {
    for (const action of Object.values(actions)) {
      records.push(...commandRecordFrom(action, "cli.action"));
    }
  }
  return records;
}

function commandRecordFrom(value: unknown, source: CommandSource): CommandRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const command = (value as { command?: unknown }).command;
  if (typeof command !== "string") return [];
  return [{ source, command, args: stringArray((value as { args?: unknown }).args) }];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function matchDocker(command: string, args: string[]): string | undefined {
  const text = [command, ...args].join(" ").toLowerCase();
  if (text.includes("docker-mcp")) return "docker-mcp";
  if (/\bdocker(?:-compose)?\b/u.test(text)) return command === "docker" ? command : text;
  return text.includes("docker mcp") ? "docker mcp" : undefined;
}

function matchBrowser(command: string, args: string[]): string | undefined {
  const text = [command, ...args].join(" ").toLowerCase();
  if (text.includes("@playwright/mcp")) return "@playwright/mcp";
  if (text.includes("playwright install")) return "playwright install";
  if (text.includes("playwright")) return "playwright";
  if (text.includes("browser-use")) return "browser-use";
  if (text.includes("puppeteer")) return "puppeteer";
  if (text.includes("chromium")) return "chromium";
  return /\bchrome\b/u.test(text) ? "chrome" : undefined;
}

function orderedFeatures(features: RuntimeFeature[]): RuntimeFeature[] {
  return ["docker", "browser"].filter((feature): feature is RuntimeFeature =>
    features.includes(feature as RuntimeFeature),
  );
}
