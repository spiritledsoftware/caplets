export const CLOUD_AUTH_STATES = [
  "unauthenticated",
  "login_pending",
  "workspace_selection_required",
  "authenticated",
  "refreshable",
  "switch_required",
  "expired",
  "revoked",
] as const;

export type CloudAuthState = (typeof CLOUD_AUTH_STATES)[number];

export type CloudAuthScope = "project_binding:read" | "project_binding:write" | string;

export type CloudAuthWorkspace = {
  workspaceId: string;
  slug?: string | undefined;
  displayName?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  selected?: boolean | undefined;
};

export type CloudAuthLoginStart = {
  loginId: string;
  loginUrl: string;
  userCode: string;
  expiresAt: string;
  requestId?: string | undefined;
};

export type CloudAuthLoginPollResult =
  | {
      status: "pending";
      expiresAt?: string | undefined;
      requestId?: string | undefined;
    }
  | {
      status: "workspace_selection_required";
      workspaces: CloudAuthWorkspace[];
      expiresAt?: string | undefined;
      requestId?: string | undefined;
    }
  | {
      status: "completed";
      selectedWorkspace?: Pick<CloudAuthWorkspace, "workspaceId" | "slug"> | undefined;
      oneTimeCode: string;
      requestId?: string | undefined;
    }
  | {
      status: "expired" | "denied" | "consumed";
      message?: string | undefined;
      requestId?: string | undefined;
    };

export type CloudAuthTokenResponse = {
  status?: "authenticated" | undefined;
  cloudUrl?: string | undefined;
  workspaceId: string;
  workspaceSlug?: string | undefined;
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt: string;
  scope?: CloudAuthScope[] | string | undefined;
  tokenType?: "Bearer" | string | undefined;
  credentialFamilyId?: string | undefined;
  deviceName?: string | undefined;
  requestId?: string | undefined;
};

export type RedactedCloudAuthStatus = {
  authenticated: boolean;
  status: CloudAuthState;
  cloudUrl?: string | undefined;
  workspaceId?: string | undefined;
  workspaceSlug?: string | undefined;
  expiresAt?: string | undefined;
  scope?: CloudAuthScope[] | undefined;
  tokenType?: string | undefined;
  credentialFamilyId?: string | undefined;
  deviceName?: string | undefined;
  createdAt?: string | undefined;
  lastRefreshAt?: string | undefined;
  selectedWorkspaceSwitchedAt?: string | undefined;
};
