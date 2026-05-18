import { describe, expect, it, vi } from "vitest";
import type { NativeCapletsService } from "../src/native";
import { registerNativeCapletsProcessCleanup } from "../src/native";

describe("registerNativeCapletsProcessCleanup", () => {
  it("waits for async cleanup before exiting on SIGTERM", async () => {
    const handlers = new Map<string, () => void>();
    const once = vi.spyOn(process, "once").mockImplementation((event, handler) => {
      handlers.set(String(event), handler as () => void);
      return process;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const closeOrder: string[] = [];
    let finishClose!: () => void;
    const service = mockService(
      () =>
        new Promise<void>((resolve) => {
          finishClose = () => {
            closeOrder.push("close");
            resolve();
          };
        }),
    );

    try {
      registerNativeCapletsProcessCleanup(service);
      handlers.get("SIGTERM")?.();

      expect(exit).not.toHaveBeenCalled();
      finishClose();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      closeOrder.push("exit");
      expect(closeOrder).toEqual(["close", "exit"]);
      expect(service.close).toHaveBeenCalledTimes(1);
    } finally {
      once.mockRestore();
      exit.mockRestore();
    }
  });
});

function mockService(close: () => Promise<void>): NativeCapletsService {
  return {
    listTools: vi.fn(() => []),
    execute: vi.fn(async () => ({})),
    reload: vi.fn(async () => true),
    onToolsChanged: vi.fn(() => () => {}),
    close: vi.fn(close),
  };
}
