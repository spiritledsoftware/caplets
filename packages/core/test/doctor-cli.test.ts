import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";

describe("caplets doctor", () => {
  it("shows local mode without remote sync details", async () => {
    const out: string[] = [];

    await runCli(["doctor"], {
      env: {},
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).toContain("Mode: local");
    expect(out.join("")).not.toContain("Mutagen");
  });

  it("shows remote mode diagnostics", async () => {
    const out: string[] = [];

    await runCli(["doctor"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "https://cloud.caplets.dev/ws/ian",
      },
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).toContain("Mode: remote");
    expect(out.join("")).toContain("Server: https://cloud.caplets.dev/ws/ian");
    expect(out.join("")).toContain("Project sync");
    expect(out.join("")).toContain("Mutagen:");
  });
});
