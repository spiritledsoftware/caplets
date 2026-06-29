import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_TELEMETRY_STATE_DIR } from "../config/paths";

export type TelemetrySurface = "cli" | "serve" | "attach" | "daemon" | "native" | "code_mode";
export type TelemetryVisibility = "visible" | "hidden" | "unknown";
export type TelemetryExecutionContext = "interactive" | "noninteractive" | "ci";
export type TelemetryStateStatus = "enabled" | "disabled" | "suppressed" | "debug";
export type TelemetryStateDecider = "debug" | "env" | "config" | "test" | "notice" | "default";

export type TelemetryIdentity =
  | { kind: "stable"; id: string }
  | { kind: "ephemeral"; id: string; reason: "state-unavailable" };

export type TelemetryNoticeState =
  | { shown: false }
  | { shown: true; shownAt: string; surface: TelemetrySurface };

export type TelemetryDeliveryHealth = Record<string, Record<string, number>>;
export type TelemetryAttributionMarker = "landing_install" | "docs_install" | "catalog_install";
export type TelemetryAttributionSource = "landing" | "docs" | "catalog";
export type TelemetryAttributionIntent = "install_run";
export type TelemetryAttribution = {
  source: TelemetryAttributionSource;
  intent: TelemetryAttributionIntent;
  marker: TelemetryAttributionMarker;
  createdAt: string;
};

export type TelemetryState = {
  status: TelemetryStateStatus;
  decider: TelemetryStateDecider;
  surface: TelemetrySurface;
  visibility: TelemetryVisibility;
  executionContext: TelemetryExecutionContext;
  notice: TelemetryNoticeState;
  stateDir?: string | undefined;
  identity?: TelemetryIdentity | undefined;
};

export type TelemetryStateOptions = {
  stateDir?: string | undefined;
};

export function telemetryStateDir(options: TelemetryStateOptions = {}): string {
  return options.stateDir ?? DEFAULT_TELEMETRY_STATE_DIR;
}

export function telemetryIdentityPath(options: TelemetryStateOptions = {}): string {
  return join(telemetryStateDir(options), "identity.json");
}

export function telemetryNoticePath(options: TelemetryStateOptions = {}): string {
  return join(telemetryStateDir(options), "notice.json");
}

export function telemetryDeliveryHealthPath(options: TelemetryStateOptions = {}): string {
  return join(telemetryStateDir(options), "delivery-health.json");
}

export function telemetryAttributionPath(options: TelemetryStateOptions = {}): string {
  return join(telemetryStateDir(options), "attribution.json");
}

export function readTelemetryIdentity(
  options: TelemetryStateOptions & { create?: boolean | undefined } = {},
): TelemetryIdentity {
  const path = telemetryIdentityPath(options);
  const existing = readJson<{ id?: unknown }>(path);
  if (typeof existing?.id === "string" && /^anon_[a-f0-9]{32}$/u.test(existing.id)) {
    return { kind: "stable", id: existing.id };
  }

  if (!options.create) {
    return { kind: "ephemeral", id: ephemeralId(), reason: "state-unavailable" };
  }

  const identity = { id: stableId(), createdAt: new Date().toISOString() };
  if (!writePrivateJson(path, identity)) {
    return { kind: "ephemeral", id: ephemeralId(), reason: "state-unavailable" };
  }
  return { kind: "stable", id: identity.id };
}

export function rotateTelemetryIdentity(options: TelemetryStateOptions = {}): TelemetryIdentity {
  const identity = { id: stableId(), createdAt: new Date().toISOString() };
  if (!writePrivateJson(telemetryIdentityPath(options), identity)) {
    return { kind: "ephemeral", id: ephemeralId(), reason: "state-unavailable" };
  }
  return { kind: "stable", id: identity.id };
}

export function deleteTelemetryIdentity(options: TelemetryStateOptions = {}): void {
  try {
    rmSync(telemetryIdentityPath(options), { force: true });
  } catch {
    // Telemetry state operations are best effort.
  }
}

export function readTelemetryAttribution(
  options: TelemetryStateOptions = {},
): TelemetryAttribution | undefined {
  return normalizeTelemetryAttribution(readJson<unknown>(telemetryAttributionPath(options)));
}

export function writeTelemetryAttribution(
  options: TelemetryStateOptions & { marker: string },
): TelemetryAttribution | undefined {
  const attribution = attributionFromMarker(options.marker);
  if (!attribution) return undefined;
  if (!writePrivateJson(telemetryAttributionPath(options), attribution)) return undefined;
  return attribution;
}

export function consumeTelemetryAttribution(
  options: TelemetryStateOptions & { env?: NodeJS.ProcessEnv | undefined } = {},
): TelemetryAttribution | undefined {
  const envMarker = options.env?.CAPLETS_INSTALL_ATTRIBUTION;
  const envAttribution =
    typeof envMarker === "string" ? attributionFromMarker(envMarker) : undefined;
  if (envAttribution) {
    return envAttribution;
  }
  const stored = readTelemetryAttribution(options);
  if (stored) {
    deleteTelemetryAttribution(options);
  }
  return stored;
}

export function deleteTelemetryAttribution(options: TelemetryStateOptions = {}): void {
  try {
    rmSync(telemetryAttributionPath(options), { force: true });
  } catch {
    // Telemetry state operations are best effort.
  }
}

export function readTelemetryNotice(options: TelemetryStateOptions = {}): TelemetryNoticeState {
  const existing = readJson<{
    shown?: unknown;
    shownAt?: unknown;
    surface?: unknown;
  }>(telemetryNoticePath(options));
  if (
    existing?.shown === true &&
    typeof existing.shownAt === "string" &&
    isTelemetrySurface(existing.surface)
  ) {
    return { shown: true, shownAt: existing.shownAt, surface: existing.surface };
  }
  return { shown: false };
}

export function recordTelemetryNoticeShown(
  options: TelemetryStateOptions & { surface: TelemetrySurface },
): TelemetryNoticeState {
  const notice = {
    shown: true,
    shownAt: new Date().toISOString(),
    surface: options.surface,
  } as const;
  writePrivateJson(telemetryNoticePath(options), notice);
  return notice;
}

export function readTelemetryDeliveryHealth(
  options: TelemetryStateOptions = {},
): TelemetryDeliveryHealth {
  const existing = readJson<unknown>(telemetryDeliveryHealthPath(options));
  if (!isDeliveryHealth(existing)) {
    return {};
  }
  return existing;
}

export function recordTelemetryDrop(
  options: TelemetryStateOptions & { provider: string; reason: string },
): void {
  const health = readTelemetryDeliveryHealth(options);
  health[options.provider] = health[options.provider] ?? {};
  health[options.provider]![options.reason] = (health[options.provider]![options.reason] ?? 0) + 1;
  writePrivateJson(telemetryDeliveryHealthPath(options), health);
}

export function writePrivateJson(path: string, value: unknown): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function stableId(): string {
  return `anon_${randomBytes(16).toString("hex")}`;
}

function ephemeralId(): string {
  return `ephemeral_${randomBytes(16).toString("hex")}`;
}

function isTelemetrySurface(value: unknown): value is TelemetrySurface {
  return (
    value === "cli" ||
    value === "serve" ||
    value === "attach" ||
    value === "daemon" ||
    value === "native" ||
    value === "code_mode"
  );
}

function attributionFromMarker(marker: string): TelemetryAttribution | undefined {
  if (marker === "landing_install") return newTelemetryAttribution("landing", marker);
  if (marker === "docs_install") return newTelemetryAttribution("docs", marker);
  if (marker === "catalog_install") return newTelemetryAttribution("catalog", marker);
  return undefined;
}

function normalizeTelemetryAttribution(value: unknown): TelemetryAttribution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !isTelemetryAttributionSource(record.source) ||
    record.intent !== "install_run" ||
    !isTelemetryAttributionMarker(record.marker) ||
    typeof record.createdAt !== "string"
  ) {
    return undefined;
  }
  if (attributionFromMarker(record.marker)?.source !== record.source) return undefined;
  return {
    source: record.source,
    intent: "install_run",
    marker: record.marker,
    createdAt: record.createdAt,
  };
}

function newTelemetryAttribution(
  source: TelemetryAttributionSource,
  marker: TelemetryAttributionMarker,
): TelemetryAttribution {
  return {
    source,
    intent: "install_run",
    marker,
    createdAt: new Date().toISOString(),
  };
}

function isTelemetryAttributionMarker(value: unknown): value is TelemetryAttributionMarker {
  return value === "landing_install" || value === "docs_install" || value === "catalog_install";
}

function isTelemetryAttributionSource(value: unknown): value is TelemetryAttributionSource {
  return value === "landing" || value === "docs" || value === "catalog";
}

function isDeliveryHealth(value: unknown): value is TelemetryDeliveryHealth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const provider of Object.values(value)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) return false;
    for (const count of Object.values(provider)) {
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return false;
    }
  }
  return true;
}
