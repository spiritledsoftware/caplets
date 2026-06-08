import type { JsonValue } from "../code-mode/types";

export const OBSERVED_OUTPUT_SHAPE_VERSION = 1;

export const OBSERVED_OUTPUT_SHAPE_LIMITS = {
  maxDepth: 6,
  maxObjectFields: 40,
  maxArrayElements: 20,
  maxUnionVariants: 4,
  maxTypeScriptChars: 4_000,
  maxStoredJsonBytes: 16_000,
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  maxLocalEntries: 2_000,
} as const;

export type JsonShape =
  | { kind: "null" }
  | { kind: "boolean" }
  | { kind: "number" }
  | { kind: "string" }
  | { kind: "unknown" }
  | { kind: "array"; element?: JsonShape; truncated?: boolean }
  | {
      kind: "object";
      fields: Record<string, { optional: boolean; shape: JsonShape }>;
      truncated?: boolean;
    }
  | { kind: "union"; variants: JsonShape[] };

export type ObservedOutputShape = {
  version: 1;
  source: "observed";
  observedAt: string;
  sampleCount: number;
  typeScript: string;
  jsonShape: JsonShape;
  truncated: boolean;
};

export type ObservedOutputShapeKey = {
  scope: "local" | "self_hosted" | "cloud";
  workspaceId?: string | undefined;
  projectFingerprint?: string | undefined;
  capletId: string;
  backendKind: string;
  backendFingerprint: string;
  toolName: string;
  toolDescriptorHash?: string | undefined;
  outputSchemaHash?: string | undefined;
  resultVersion: 1;
};

export type ObservedOutputShapePruneResult = {
  removed: number;
  remaining: number;
};

export type ObservedOutputShapeStoreHealth = {
  path?: string | undefined;
  readable: boolean;
  writable: boolean;
  entryCount?: number | undefined;
  prune?: ObservedOutputShapePruneResult | undefined;
  error?: string | undefined;
};

export interface ObservedOutputShapeStore {
  read(key: ObservedOutputShapeKey): Promise<ObservedOutputShape | undefined>;
  write(key: ObservedOutputShapeKey, shape: ObservedOutputShape): Promise<void>;
  prune?(now?: Date): Promise<ObservedOutputShapePruneResult>;
  health?(): Promise<ObservedOutputShapeStoreHealth>;
}

export type ExtractObservedOutputShapeInput = {
  value: unknown;
  now?: Date | undefined;
  existing?: ObservedOutputShape | undefined;
};

export type ExtractedJsonValue = Extract<JsonValue, unknown[] | { [key: string]: JsonValue }>;
