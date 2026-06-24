import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import {
  defaultTelemetryDeliveryHealthPath,
  defaultTelemetryIdentityPath,
  defaultTelemetryNoticePath,
} from "../src/config/paths";
import {
  readTelemetryDeliveryHealth,
  readTelemetryIdentity,
  readTelemetryNotice,
  recordTelemetryDrop,
  recordTelemetryNoticeShown,
  resolveTelemetryState,
  rotateTelemetryIdentity,
} from "../src/telemetry";

const roots: string[] = [];

function tempRoot(): string {
  const root = join(mkdtempSync(join(tmpdir(), "caplets-telemetry-")), "state");
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

describe("telemetry state", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves state paths under Caplets state", () => {
    const home = "/home/alex";
    expect(defaultTelemetryIdentityPath({}, home, "linux")).toBe(
      join(home, ".local", "state", "caplets", "telemetry", "identity.json"),
    );
    expect(defaultTelemetryNoticePath({}, home, "linux")).toBe(
      join(home, ".local", "state", "caplets", "telemetry", "notice.json"),
    );
    expect(defaultTelemetryDeliveryHealthPath({}, home, "linux")).toBe(
      join(home, ".local", "state", "caplets", "telemetry", "delivery-health.json"),
    );
  });

  it("uses a stable random identity and preserves it across disablement", () => {
    const stateDir = tempRoot();
    const first = readTelemetryIdentity({ stateDir, create: true });
    const second = readTelemetryIdentity({ stateDir, create: true });

    expect(first.kind).toBe("stable");
    expect(first.id).toMatch(/^anon_[a-f0-9]{32}$/u);
    expect(second.id).toBe(first.id);

    const disabled = resolveTelemetryState({
      config: parseConfig({ telemetry: false }),
      stateDir,
      env: {},
      surface: "cli",
      visibility: "visible",
    });

    expect(disabled.status).toBe("disabled");
    expect(readTelemetryIdentity({ stateDir, create: false }).id).toBe(first.id);
  });

  it("rotates identity with owner-only file permissions where supported", () => {
    const stateDir = tempRoot();
    const first = readTelemetryIdentity({ stateDir, create: true });
    const second = rotateTelemetryIdentity({ stateDir });

    expect(second.id).not.toBe(first.id);
    if (process.platform !== "win32") {
      expect(statSync(join(stateDir, "identity.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("records visible notice only when explicitly marked", () => {
    const stateDir = tempRoot();

    expect(readTelemetryNotice({ stateDir }).shown).toBe(false);
    recordTelemetryNoticeShown({ stateDir, surface: "cli" });

    const notice = readTelemetryNotice({ stateDir });
    expect(notice.shown).toBe(true);
    if (!notice.shown) throw new Error("expected notice to be shown");
    expect(notice.surface).toBe("cli");
  });

  it("disables telemetry when env, config, or test detection says so", () => {
    const base = {
      stateDir: tempRoot(),
      surface: "cli" as const,
      visibility: "visible" as const,
    };

    expect(
      resolveTelemetryState({ ...base, env: { CAPLETS_DISABLE_TELEMETRY: "1" } }).decider,
    ).toBe("env");
    expect(
      resolveTelemetryState({ ...base, config: parseConfig({ telemetry: false }), env: {} })
        .decider,
    ).toBe("config");
    expect(resolveTelemetryState({ ...base, env: { VITEST: "true" } }).decider).toBe("test");
  });

  it("suppresses non-CI telemetry until notice exists", () => {
    const stateDir = tempRoot();
    for (const visibility of ["visible", "hidden", "unknown"] as const) {
      const beforeNotice = resolveTelemetryState({
        stateDir,
        env: {},
        surface: "native",
        visibility,
      });
      expect(beforeNotice.status).toBe("suppressed");
      expect(beforeNotice.decider).toBe("notice");
    }

    recordTelemetryNoticeShown({ stateDir, surface: "cli" });

    const afterNotice = resolveTelemetryState({
      stateDir,
      env: {},
      surface: "native",
      visibility: "hidden",
    });
    expect(afterNotice.status).toBe("enabled");
  });

  it("classifies CI without mutating visible notice and falls back to ephemeral identity", () => {
    const stateDir = tempRoot();
    const state = resolveTelemetryState({
      stateDir,
      env: { CI: "true" },
      surface: "cli",
      visibility: "hidden",
    });

    expect(state.status).toBe("enabled");
    expect(state.executionContext).toBe("ci");
    expect(readTelemetryNotice({ stateDir }).shown).toBe(false);

    const blockedStateDir = join(tempRoot(), "blocked-state");
    writeFileSync(blockedStateDir, "not a directory");
    const identity = readTelemetryIdentity({ stateDir: blockedStateDir, create: true });
    expect(identity.kind).toBe("ephemeral");
  });

  it("tracks local delivery health without throwing", () => {
    const stateDir = tempRoot();

    recordTelemetryDrop({ stateDir, provider: "posthog", reason: "send_failed" });
    recordTelemetryDrop({ stateDir, provider: "posthog", reason: "send_failed" });
    recordTelemetryDrop({ stateDir, provider: "sentry", reason: "disabled" });

    expect(readTelemetryDeliveryHealth({ stateDir })).toEqual({
      posthog: { send_failed: 2 },
      sentry: { disabled: 1 },
    });
    expect(JSON.parse(readFileSync(join(stateDir, "delivery-health.json"), "utf8"))).toEqual({
      posthog: { send_failed: 2 },
      sentry: { disabled: 1 },
    });
  });

  it("does not create state files while merely resolving disabled telemetry", () => {
    const stateDir = tempRoot();

    resolveTelemetryState({
      config: parseConfig({ telemetry: false }),
      stateDir,
      env: {},
      surface: "cli",
      visibility: "visible",
    });

    expect(existsSync(join(stateDir, "identity.json"))).toBe(false);
  });
});
