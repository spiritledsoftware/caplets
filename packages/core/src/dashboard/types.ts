import type { RemoteClientRole } from "../remote/server-credentials";

export const DASHBOARD_SESSION_COOKIE = "caplets_dashboard_session";

export type DashboardSessionRecord = {
  sessionId: string;
  secretHash: string;
  operatorClientId: string;
  role: RemoteClientRole;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
};

export type DashboardSessionView = {
  sessionId: string;
  operatorClientId: string;
  role: RemoteClientRole;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
};
