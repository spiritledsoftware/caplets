export declare const SURFACE_THRESHOLDS: {
  minInitialPayloadReduction: number;
};

export declare function benchmarkServerDefinitions(): Record<string, Record<string, unknown>>;
export declare function directFlatTools(): Array<Record<string, unknown>>;
export declare function directFlatPayload(): { tools: Array<Record<string, unknown>> };
export declare function capletsTopLevelPayload(): Promise<{
  payload: { tools: Array<Record<string, unknown>> };
  implementation: string;
}>;
export declare function computeSurfaceBenchmark(): Promise<Record<string, any>>;
export declare function validateSurfaceBenchmark(result: Record<string, any>): string[];
export declare function renderMarkdownReport(result: Record<string, any>): string;
