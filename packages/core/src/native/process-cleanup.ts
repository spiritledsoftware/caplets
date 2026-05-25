import type { NativeCapletsService } from "./service";

export type NativeCapletsProcessCleanupOptions = {
  writeErr?: (message: string) => void;
};

export function registerNativeCapletsProcessCleanup(
  service: NativeCapletsService,
  options: NativeCapletsProcessCleanupOptions = {},
): void {
  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await service.close();
    } catch (error: unknown) {
      options.writeErr?.(`Failed to close Caplets service: ${errorMessage(error)}\n`);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
