import type { NativeCapletsService } from "./service.js";

export function registerNativeCapletsProcessCleanup(service: NativeCapletsService): void {
  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await service.close();
    } catch (error: unknown) {
      console.error("Failed to close Caplets service:", error);
      process.exitCode = 1;
    }
  };
  const closeBeforeExit = () => {
    void close();
  };
  const closeAndExit = () => {
    void close().finally(() => {
      process.exit(process.exitCode ?? 0);
    });
  };
  process.once("beforeExit", closeBeforeExit);
  process.once("SIGINT", closeAndExit);
  process.once("SIGTERM", closeAndExit);
}
