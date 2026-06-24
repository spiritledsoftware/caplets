import {
  recordTelemetryNoticeShown,
  type TelemetrySurface,
  type TelemetryStateOptions,
} from "./state";

export const TELEMETRY_NOTICE =
  "Caplets collects anonymous telemetry for product usage and reliability. Disable it with CAPLETS_DISABLE_TELEMETRY=1 or `caplets telemetry disable`.\n";

export type TelemetryNoticeOptions = TelemetryStateOptions & {
  surface: TelemetrySurface;
  stderrIsTTY?: boolean | undefined;
  writeErr: (text: string) => void;
};

export function maybePrintTelemetryNotice(options: TelemetryNoticeOptions): boolean {
  if (!options.stderrIsTTY) return false;
  options.writeErr(TELEMETRY_NOTICE);
  recordTelemetryNoticeShown({ ...options, surface: options.surface });
  return true;
}
