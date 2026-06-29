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
  if (trimmed.includes("CAPLETS_INSTALL_ATTRIBUTION=")) return trimmed;
  return `CAPLETS_INSTALL_ATTRIBUTION=${attributionMarkerForSurface(surface)} ${trimmed}`;
}
