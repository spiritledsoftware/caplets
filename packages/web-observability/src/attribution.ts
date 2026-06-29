import type { WebSurface } from "./events";

export type WebAttributionMarker = "landing_install" | "docs_install" | "catalog_install";

export function attributionMarkerForSurface(surface: WebSurface): WebAttributionMarker {
  if (surface === "landing") return "landing_install";
  if (surface === "docs") return "docs_install";
  return "catalog_install";
}

export function attributedInstallCommand(command: string, surface: WebSurface): string {
  const trimmed = command.trim();
  if (!trimmed) return trimmed;
  if (
    trimmed.includes(" telemetry attribution ") ||
    trimmed.includes("CAPLETS_INSTALL_ATTRIBUTION=")
  ) {
    return trimmed;
  }
  const runner = capletsRunnerForCommand(trimmed);
  return `${runner} telemetry attribution ${attributionMarkerForSurface(surface)}\n${trimmed}`;
}

function capletsRunnerForCommand(command: string): string {
  const words = command.split(/\s+/u);
  const capletsIndex = words.indexOf("caplets");
  if (capletsIndex <= 0) return "caplets";
  return words.slice(0, capletsIndex + 1).join(" ");
}
