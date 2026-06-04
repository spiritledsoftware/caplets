import { describe, expect, it, vi } from "vitest";
import {
  ManagedMutagenProjectSync,
  mutagenProjectSyncDoctorData,
  parseMutagenVersionOutput,
} from "../src/project-binding/mutagen";

describe("managed Project Binding sync adapter", () => {
  it("records available Mutagen version information after start", async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === "version") {
        return { stdout: "Mutagen version 0.18.1\nLicense profile: mit\n", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    const sync = new ManagedMutagenProjectSync({ mutagenBinary: "/bin/mutagen", runner: run });

    await sync.start({
      bindingId: "bind_1",
      localProjectRoot: "/repo",
      serverProjectRoot: "/state/workspaces/fingerprint/project",
    });

    expect(mutagenProjectSyncDoctorData(sync.snapshot())).toMatchObject({
      state: "syncing",
      mutagenBinary: "/bin/mutagen",
      mutagenVersion: "0.18.1",
    });
  });

  it("blocks with a stable diagnostic when the binary is unavailable", async () => {
    const sync = new ManagedMutagenProjectSync({
      runner: async () => {
        throw new Error("not found");
      },
    });

    await sync.start({
      bindingId: "bind_1",
      localProjectRoot: "/repo",
      serverProjectRoot: "/state/workspaces/fingerprint/project",
    });

    expect(mutagenProjectSyncDoctorData(sync.snapshot())).toMatchObject({
      state: "blocked",
      diagnosticCode: "project_sync_binary_missing",
    });
  });

  it("parses unknown version output conservatively", () => {
    expect(parseMutagenVersionOutput("mutagen dev build")).toEqual({
      version: "unknown",
    });
  });
});
