import type { TelemetryEvent } from "./events";

export type TelemetryDebugRecord = {
  state: "debug" | "enabled" | "disabled" | "suppressed";
  event: TelemetryEvent;
};

export class TelemetryDebugSink {
  readonly records: TelemetryDebugRecord[] = [];

  capture(state: TelemetryDebugRecord["state"], event: TelemetryEvent): void {
    this.records.push({ state, event });
  }

  toJSON(): TelemetryDebugRecord[] {
    return this.records;
  }
}
