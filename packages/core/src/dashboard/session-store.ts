import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CapletsError } from "../errors";
import type { DashboardSessionRepository } from "../storage/dashboard-sessions";
import {
  DASHBOARD_SESSION_COOKIE,
  DASHBOARD_SESSION_ABSOLUTE_TIMEOUT_MS,
  DASHBOARD_SESSION_IDLE_TIMEOUT_MS,
  type DashboardSessionRecord,
  type DashboardSessionView,
} from "./types";

export type DashboardOperatorClientValidator = (operatorClientId: string) => Promise<boolean>;

export type DashboardSessionStoreOptions = {
  repository: DashboardSessionRepository;
  validateOperatorClient: DashboardOperatorClientValidator;
};

export class DashboardSessionStore {
  private readonly repository: DashboardSessionRepository;
  private readonly validateOperatorClient: DashboardOperatorClientValidator;

  constructor(options: DashboardSessionStoreOptions) {
    this.repository = options.repository;
    this.validateOperatorClient = options.validateOperatorClient;
  }

  async create(input: { operatorClientId: string; now?: Date | undefined }): Promise<{
    cookieValue: string;
    session: DashboardSessionView;
  }> {
    const now = input.now ?? new Date();
    await this.repository.cleanupExpired(now);
    while (true) {
      const secret = `dash_secret_${randomToken(32)}`;
      const session: DashboardSessionRecord = {
        sessionId: `dash_${randomToken(12)}`,
        secretHash: hashSecret(secret),
        operatorClientId: input.operatorClientId,
        role: "operator",
        csrfToken: `csrf_${randomToken(32)}`,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + DASHBOARD_SESSION_ABSOLUTE_TIMEOUT_MS).toISOString(),
        lastUsedAt: now.toISOString(),
      };
      if (await this.repository.create(session)) {
        return { cookieValue: `${session.sessionId}.${secret}`, session: sessionView(session) };
      }
    }
  }

  async validate(input: {
    cookieHeader?: string | undefined;
    csrfToken?: string | undefined;
    requireCsrf?: boolean | undefined;
    now?: Date | undefined;
  }): Promise<DashboardSessionView> {
    const now = input.now ?? new Date();
    const parsed = parseDashboardCookie(input.cookieHeader);
    const session = parsed ? await this.repository.get(parsed.sessionId) : undefined;
    await this.repository.cleanupExpired(now);
    if (!parsed) {
      throw new CapletsError("AUTH_FAILED", "Dashboard session is required.");
    }
    if (!session || !safeHashEqual(hashSecret(parsed.secret), session.secretHash)) {
      throw new CapletsError("AUTH_FAILED", "Dashboard session is invalid.");
    }
    const expired = Date.parse(session.expiresAt) <= now.getTime();
    const idleExpired =
      now.getTime() - Date.parse(session.lastUsedAt) > DASHBOARD_SESSION_IDLE_TIMEOUT_MS;
    if (expired || idleExpired) {
      throw new CapletsError("AUTH_FAILED", "Dashboard session has expired.");
    }
    if (!(await this.validateOperatorClient(session.operatorClientId))) {
      await this.repository.delete(session.sessionId, {
        expectedSecretHash: session.secretHash,
      });
      throw new CapletsError("AUTH_FAILED", "Dashboard operator client is no longer authorized.");
    }
    if (input.requireCsrf && input.csrfToken !== session.csrfToken) {
      throw new CapletsError("REQUEST_INVALID", "Dashboard CSRF token is invalid.");
    }
    const touched = await this.repository.touch(session.sessionId, session.secretHash, now);
    if (!touched) {
      throw new CapletsError("AUTH_FAILED", "Dashboard session has expired.");
    }
    return sessionView(touched);
  }

  async delete(cookieHeader?: string | undefined): Promise<boolean> {
    const parsed = parseDashboardCookie(cookieHeader);
    if (!parsed) return false;
    return await this.repository.delete(parsed.sessionId, { operatorInitiated: true });
  }
}

function sessionView(session: DashboardSessionRecord): DashboardSessionView {
  return {
    sessionId: session.sessionId,
    operatorClientId: session.operatorClientId,
    role: "operator",
    csrfToken: session.csrfToken,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastUsedAt: session.lastUsedAt,
  };
}

export function parseDashboardCookie(
  cookieHeader: string | undefined,
): { sessionId: string; secret: string } | undefined {
  const value = (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${DASHBOARD_SESSION_COOKIE}=`))
    ?.slice(DASHBOARD_SESSION_COOKIE.length + 1);
  if (!value) return undefined;
  const [sessionId, secret] = value.split(".", 2);
  if (!sessionId || !secret) return undefined;
  return { sessionId, secret };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}
