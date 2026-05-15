import type { NativeCapletsService } from "./service.js";

export function registerNativeCapletsProcessCleanup(service: NativeCapletsService): void {
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    service.close().catch((error: unknown) => {
      console.error("Failed to close Caplets service:", error);
      process.exitCode = 1;
    });
  };
  process.once("beforeExit", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
