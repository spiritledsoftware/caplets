import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardSessionStore } from "../src/dashboard/session-store";
import { DASHBOARD_SESSION_COOKIE } from "../src/dashboard/types";
import { createHostStorage, type HostStorage } from "../src/storage";
import { DashboardSessionRepository } from "../src/storage/dashboard-sessions";
import * as sqlite from "../src/storage/schema/sqlite";

const NOW = new Date("2026-07-18T12:00:00.000Z");

let root: string;
let firstStorage: HostStorage;
let secondStorage: HostStorage;
let firstRepository: DashboardSessionRepository;
let secondRepository: DashboardSessionRepository;
let authorizedClients: Set<string>;
let firstStore: DashboardSessionStore;
let secondStore: DashboardSessionStore;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "caplets-dashboard-sessions-"));
  const path = join(root, "caplets.sqlite3");
  firstStorage = await createHostStorage({ type: "sqlite", path });
  secondStorage = await createHostStorage({ type: "sqlite", path });
  firstRepository = new DashboardSessionRepository(firstStorage.database);
  secondRepository = new DashboardSessionRepository(secondStorage.database);
  authorizedClients = new Set(["operator_browser"]);
  firstStore = new DashboardSessionStore({
    repository: firstRepository,
    validateOperatorClient: async (clientId) => authorizedClients.has(clientId),
  });
  secondStore = new DashboardSessionStore({
    repository: secondRepository,
    validateOperatorClient: async (clientId) => authorizedClients.has(clientId),
  });
});

afterEach(async () => {
  await firstStorage.close();
  await secondStorage.close();
  rmSync(root, { recursive: true, force: true });
});

describe("SQL-backed dashboard sessions", () => {
  it("creates, validates, and touches a session visible to another SQLite instance", async () => {
    const created = await firstStore.create({ operatorClientId: "operator_browser", now: NOW });
    const persisted = await firstRepository.get(created.session.sessionId);
    if (!persisted) throw new Error("Created dashboard session was not persisted.");
    await expect(secondRepository.create(persisted)).resolves.toBe(false);
    const touchedAt = new Date(NOW.getTime() + 30 * 60_000);

    const validated = await secondStore.validate({
      cookieHeader: cookieHeader(created.cookieValue),
      csrfToken: created.session.csrfToken,
      requireCsrf: true,
      now: touchedAt,
    });

    expect(validated).toEqual({ ...created.session, lastUsedAt: touchedAt.toISOString() });
    await expect(firstRepository.get(created.session.sessionId)).resolves.toMatchObject({
      ...created.session,
      secretHash: expect.any(String),
      lastUsedAt: touchedAt.toISOString(),
    });
  });

  it("rejects the wrong cookie secret and CSRF token without touching the session", async () => {
    const created = await firstStore.create({ operatorClientId: "operator_browser", now: NOW });
    const later = new Date(NOW.getTime() + 5 * 60_000);

    await expect(
      secondStore.validate({
        cookieHeader: cookieHeader(`${created.session.sessionId}.wrong-secret`),
        now: later,
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(
      secondStore.validate({
        cookieHeader: cookieHeader(created.cookieValue),
        csrfToken: "wrong-csrf",
        requireCsrf: true,
        now: later,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(firstRepository.get(created.session.sessionId)).resolves.toMatchObject({
      lastUsedAt: NOW.toISOString(),
    });
  });

  it("deletes absolutely expired and idle-expired sessions", async () => {
    const absolute = await firstStore.create({ operatorClientId: "operator_browser", now: NOW });
    await expect(
      secondStore.validate({
        cookieHeader: cookieHeader(absolute.cookieValue),
        now: new Date(NOW.getTime() + 12 * 60 * 60_000),
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(firstRepository.get(absolute.session.sessionId)).resolves.toBeUndefined();

    const idleCreatedAt = new Date(NOW.getTime() + 13 * 60 * 60_000);
    const idle = await firstStore.create({
      operatorClientId: "operator_browser",
      now: idleCreatedAt,
    });
    await expect(
      secondStore.validate({
        cookieHeader: cookieHeader(idle.cookieValue),
        now: new Date(idleCreatedAt.getTime() + 60 * 60_000 + 1),
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(firstRepository.get(idle.session.sessionId)).resolves.toBeUndefined();
  });

  it("deletes a session whose remote operator client was revoked", async () => {
    const created = await firstStore.create({ operatorClientId: "operator_browser", now: NOW });
    authorizedClients.delete("operator_browser");

    await expect(
      secondStore.validate({
        cookieHeader: cookieHeader(created.cookieValue),
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(firstRepository.get(created.session.sessionId)).resolves.toBeUndefined();
  });

  it("deletes a session on logout and rejects persisted invalid payloads", async () => {
    const created = await firstStore.create({ operatorClientId: "operator_browser", now: NOW });
    await expect(secondStore.delete(cookieHeader(created.cookieValue))).resolves.toBe(true);
    await expect(firstStore.delete(cookieHeader(created.cookieValue))).resolves.toBe(false);

    if (firstStorage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage.");
    firstStorage.database.db
      .insert(sqlite.dashboardSessions)
      .values({
        sessionId: "dash_invalid",
        secretHash: "not-used",
        operatorClientId: "operator_browser",
        role: "access",
        csrfToken: "csrf_invalid",
        createdAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        lastUsedAt: NOW.toISOString(),
      })
      .run();

    await expect(
      secondStore.validate({
        cookieHeader: cookieHeader("dash_invalid.secret"),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(firstStorage.database.db.select().from(sqlite.dashboardSessions).all()).toEqual([]);
  });
});

function cookieHeader(cookieValue: string): string {
  return `${DASHBOARD_SESSION_COOKIE}=${cookieValue}`;
}
