export { CapletsRuntime } from "./runtime";
export { runCli, createProgram } from "./cli";
export { parseConfig, loadConfig } from "./config";
export { capabilityDescription, ServerRegistry } from "./registry";
export { generatedToolInputSchema, handleServerTool } from "./tools";
export type { CapletExecutionMetadata, CapletResultMetadata } from "./tools";
export type { CapletSetupCommandConfig, CapletSetupConfig } from "./config";
export { capletSetupContentHash, stableJson } from "./setup/hash";
export { LocalSetupStore } from "./setup/local-store";
export { runCapletSetup } from "./setup/runner";
export type {
  SetupActor,
  SetupApproval,
  SetupAttempt,
  SetupAttemptStatus,
  SetupPlan,
  SetupTargetKind,
} from "./setup/types";
export {
  hasRenderableStructuredContent,
  markdownCallToolResultContent,
  markdownStructuredContent,
} from "./result-content";
export type { ResultMarkdownContext } from "./result-content";

export { serveCaplets, serveHttp, serveResolvedCaplets, serveStdio } from "./serve";
export type { HttpServeOptions, RawServeOptions, ServeOptions, StdioServeOptions } from "./serve";
