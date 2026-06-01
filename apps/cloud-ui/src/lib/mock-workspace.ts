export type ConnectorStatus = "Ready" | "Needs OAuth" | "Local required";

export interface Connector {
  id: string;
  name: string;
  kind: string;
  status: ConnectorStatus;
  detail: string;
}

export interface RuntimeRow {
  label: string;
  value: string;
  state: "ok" | "warn";
}

export interface ReceiptStep {
  step: number;
  title: string;
  detail: string;
}

export interface AuditRow {
  time: string;
  event: string;
  subject: string;
  result: string;
}

export interface WorkspaceMock {
  endpoint: string;
  visibleCaplets: number;
  hiddenTools: number;
  payloadReduction: string;
  authMode: string;
  workspaceName: string;
  connectors: Connector[];
  runtimeRows: RuntimeRow[];
  receiptSteps: ReceiptStep[];
  auditRows: AuditRow[];
}

export const productCopyProofs = [
  "capability cards instead of flat downstream tool lists",
  "106 hidden downstream tools",
  "3 visible Caplets",
] as const;

export const workspaceMock: WorkspaceMock = {
  endpoint: "https://cloud.caplets.dev/ws/personal/mcp",
  visibleCaplets: 3,
  hiddenTools: 106,
  payloadReduction: "87.9% smaller initial payload",
  authMode: "OAuth",
  workspaceName: "personal workspace",
  connectors: [
    {
      id: "github",
      name: "GitHub",
      kind: "Hosted MCP",
      status: "Ready",
      detail: "OAuth state and provider tokens stay server-side for the workspace.",
    },
    {
      id: "sourcegraph",
      name: "Sourcegraph",
      kind: "Hosted API",
      status: "Needs OAuth",
      detail: "Authorize once, then expose a capability card to every connected agent.",
    },
    {
      id: "repo-tools",
      name: "Repo tools",
      kind: "Project-bound CLI",
      status: "Local required",
      detail:
        "Runs through project-bound remote stdio/CLI execution when local presence is active.",
    },
  ],
  runtimeRows: [
    { label: "Hosted connectors", value: "ready", state: "ok" },
    { label: "Sandbox leases", value: "idle", state: "ok" },
    { label: "Local-assisted sessions", value: "presence required", state: "warn" },
    { label: "Policy blockers", value: "0 blocking", state: "ok" },
  ],
  receiptSteps: [
    {
      step: 1,
      title: "Sync lease opened",
      detail: "Project files copied into the managed runtime for stdio/CLI work.",
    },
    {
      step: 2,
      title: "Remote command finished",
      detail: "project-bound remote stdio/CLI execution returned a patch receipt.",
    },
    {
      step: 3,
      title: "Implicit apply pending",
      detail: "Local runtime checks conflicts before writing back to the project root.",
    },
  ],
  auditRows: [
    {
      time: "10:48",
      event: "OAuth client authorized",
      subject: "workspace/personal",
      result: "requires workspace grant",
    },
    {
      time: "10:51",
      event: "Tool surface report generated",
      subject: "github",
      result: "87.9% smaller initial payload",
    },
    {
      time: "10:54",
      event: "Project-bound apply receipt recorded",
      subject: "repo-tools",
      result: "conflict-aware",
    },
  ],
};
