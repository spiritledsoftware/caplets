import { describe, expect, it, vi } from "vitest";
import {
  fetchPublicCapletsMetadata,
  UPDATE_CHECK_ACCEPT_HEADER,
  UPDATE_CHECK_REGISTRY_URL,
} from "../src/update-check";

describe("update-check registry", () => {
  it("fetches only the public caplets metadata endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        name: "caplets",
        "dist-tags": { latest: "0.23.0" },
        versions: { "0.22.0": {}, "0.23.0": {} },
      }),
    );

    await expect(fetchPublicCapletsMetadata({ fetcher, timeoutMs: 100 })).resolves.toMatchObject({
      packageName: "caplets",
      distTags: { latest: "0.23.0" },
      versions: ["0.22.0", "0.23.0"],
    });

    expect(fetcher).toHaveBeenCalledWith(
      UPDATE_CHECK_REGISTRY_URL,
      expect.objectContaining({
        headers: { accept: UPDATE_CHECK_ACCEPT_HEADER },
        redirect: "error",
      }),
    );
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it("rejects invalid metadata", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ name: "caplets", "dist-tags": {}, versions: {} }),
    );

    await expect(fetchPublicCapletsMetadata({ fetcher, timeoutMs: 100 })).rejects.toMatchObject({
      reason: "invalid",
    });
  });

  it("rejects oversized responses before parsing JSON", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{".repeat(128)));

    await expect(
      fetchPublicCapletsMetadata({ fetcher, timeoutMs: 100, maxResponseBytes: 16 }),
    ).rejects.toMatchObject({ reason: "too_large" });
  });

  it("honors an already-aborted caller signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.signal instanceof AbortSignal && init.signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      return Response.json({
        name: "caplets",
        "dist-tags": { latest: "0.23.0" },
        versions: { "0.22.0": {}, "0.23.0": {} },
      });
    });

    await expect(
      fetchPublicCapletsMetadata({ fetcher, signal: controller.signal, timeoutMs: 100 }),
    ).rejects.toMatchObject({ reason: "timeout" });
  });
});
