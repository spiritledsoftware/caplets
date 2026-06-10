import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_NAMES = [
  "repo",
  "filesystem",
  "sqlite",
  "docs",
  "browser",
  "memory",
  "time",
  "slack",
  "jira",
  "github",
  "observability",
  "deployments",
  "feature_flags",
  "customers",
  "incidents",
];

const emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const querySchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query, filter text, or compact selector." },
  },
  additionalProperties: false,
};
const idSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Record id, path, key, issue id, release id, or service." },
  },
  additionalProperties: false,
};
const sqlSchema = {
  type: "object",
  properties: {
    sql: { type: "string", description: "Read-only SQL query over the local fixture tables." },
  },
  additionalProperties: false,
};
const timeSchema = {
  type: "object",
  properties: {
    from: { type: "string", description: "Source ISO timestamp." },
    toZone: { type: "string", description: "Target timezone name." },
  },
  additionalProperties: false,
};
const readOnlyAnnotations = { readOnlyHint: true, idempotentHint: true };

const records = {
  incidents: [
    {
      id: "INC-9071",
      title: "Payments authorization failures",
      status: "active",
      severity: "sev1",
      service: "payments",
      rootCause: "payment token refresh regression",
      impactedRegions: ["us-east-1", "eu-west-1"],
      affectedAccountIds: ["acct-northstar", "acct-atlas", "acct-harbor", "acct-brightline"],
      owner: "payments-platform",
      runbook: "RB-PAY-042",
      startedAt: "2026-06-10T17:22:00Z",
    },
    {
      id: "INC-9012",
      title: "Checkout cache warming regression",
      status: "resolved",
      severity: "sev2",
      service: "checkout",
      rootCause: "cache warming regression",
      impactedRegions: ["us-east-1"],
      affectedAccountIds: ["acct-brightline"],
      owner: "checkout-platform",
      runbook: "RB-CHK-018",
      startedAt: "2026-06-09T08:00:00Z",
    },
    {
      id: "INC-9033",
      title: "Search indexer lag",
      status: "monitoring",
      severity: "sev3",
      service: "search-indexer",
      rootCause: "bulk import saturation",
      impactedRegions: ["us-west-2"],
      affectedAccountIds: [],
      owner: "search-platform",
      runbook: "RB-SRCH-011",
      startedAt: "2026-06-10T10:15:00Z",
    },
  ],
  customers: [
    {
      id: "acct-northstar",
      name: "Northstar Bank",
      tier: "enterprise",
      region: "us-east-1",
      arr: 2400000,
      renewalDate: "2026-07-01",
      renewalStatus: "at-risk",
      executiveOwner: "Maya Chen",
      escalationTarget: "northstar-war-room",
      blockers: ["JIRA-CUST-802", "JIRA-PAY-317"],
    },
    {
      id: "acct-atlas",
      name: "Atlas Freight",
      tier: "enterprise",
      region: "eu-west-1",
      arr: 1800000,
      renewalDate: "2026-09-15",
      renewalStatus: "watch",
      executiveOwner: "Devon Lee",
      escalationTarget: "atlas-csm",
      blockers: ["JIRA-PAY-317"],
    },
    {
      id: "acct-harbor",
      name: "Harbor Health",
      tier: "enterprise",
      region: "us-east-1",
      arr: 1200000,
      renewalDate: "2026-10-30",
      renewalStatus: "healthy",
      executiveOwner: "Priya Shah",
      escalationTarget: "harbor-support",
      blockers: [],
    },
    {
      id: "acct-brightline",
      name: "Brightline Retail",
      tier: "growth",
      region: "us-west-2",
      arr: 420000,
      renewalDate: "2026-06-25",
      renewalStatus: "healthy",
      executiveOwner: "Riley Quinn",
      escalationTarget: "brightline-csm",
      blockers: [],
    },
  ],
  releases: [
    {
      id: "REL-4419",
      service: "payments",
      status: "pending",
      version: "2026.06.10-payments",
      environment: "production",
      linkedPrs: ["GH-8842", "GH-8838"],
      linkedIssues: ["JIRA-PAY-317", "JIRA-CUST-802"],
      risk: "high",
      rollbackDoc: "DOC-RUN-rollback-payments",
    },
    {
      id: "REL-4408",
      service: "search",
      status: "approved",
      version: "2026.06.10-search",
      environment: "production",
      linkedPrs: ["GH-8801"],
      linkedIssues: ["JIRA-SEARCH-118"],
      risk: "low",
      rollbackDoc: "DOC-RUN-rollback-search",
    },
  ],
  github: [
    {
      id: "GH-8842",
      title: "Guard token refresh retry path",
      state: "open",
      service: "payments",
      releaseId: "REL-4419",
      checks: "failing",
      risk: "release-blocking",
      summary: "Unmerged fix for the payments token refresh regression.",
    },
    {
      id: "GH-8838",
      title: "Add dashboard copy for payment retries",
      state: "merged",
      service: "payments",
      releaseId: "REL-4419",
      checks: "passing",
      risk: "low",
      summary: "Merged UI text update.",
    },
    {
      id: "GH-8801",
      title: "Search tuning cleanup",
      state: "open",
      service: "search-indexer",
      releaseId: "REL-4408",
      checks: "passing",
      risk: "not related",
      summary: "Distractor PR.",
    },
  ],
  jira: [
    {
      id: "JIRA-PAY-317",
      title: "Refund authorization failures after token refresh",
      status: "In Progress",
      priority: "P0",
      service: "payments",
      blocker: true,
      account: "Northstar Bank",
    },
    {
      id: "JIRA-CUST-802",
      title: "Northstar executive review required",
      status: "Open",
      priority: "P1",
      service: "customers",
      blocker: true,
      account: "Northstar Bank",
    },
    {
      id: "JIRA-SEARCH-118",
      title: "Tune search ranking for seasonal catalog",
      status: "Open",
      priority: "P3",
      service: "search-indexer",
      blocker: false,
      account: "Brightline Retail",
    },
  ],
  docs: [
    {
      id: "RB-PAY-042",
      path: "runbooks/payments-authorization.md",
      title: "Payments authorization incident runbook",
      service: "payments",
      stale: false,
      summary: "Use for payment token refresh regression response; owner payments-platform.",
    },
    {
      id: "DOC-RUN-rollback-payments",
      path: "runbooks/payments-rollback.md",
      title: "Payments rollback guide",
      service: "payments",
      stale: true,
      summary: "Rollback guide for REL-4419; stale because last reviewed 2026-05-01.",
    },
    {
      id: "DOC-PLAY-renewal-enterprise",
      path: "playbooks/enterprise-renewal.md",
      title: "Enterprise renewal playbook",
      service: "customers",
      stale: false,
      summary: "At-risk renewals above 2M ARR require schedule exec review.",
    },
    {
      id: "DOC-RUN-rollback-search",
      path: "runbooks/search-rollback.md",
      title: "Search rollback guide",
      service: "search-indexer",
      stale: false,
      summary: "Distractor rollback guide.",
    },
  ],
  slack: [
    {
      id: "SLACK-1001",
      channel: "#incidents",
      text: "INC-9071 confirmed payments-platform owner; use RB-PAY-042.",
      timestamp: "2026-06-10T17:34:00Z",
    },
    {
      id: "SLACK-1002",
      channel: "#sales-enterprise",
      text: "Northstar Bank renewal is at-risk; Maya Chen wants schedule exec review.",
      timestamp: "2026-06-10T15:15:00Z",
    },
    {
      id: "SLACK-1003",
      channel: "#checkout",
      text: "INC-9012 checkout issue resolved yesterday.",
      timestamp: "2026-06-09T12:00:00Z",
    },
  ],
  observability: [
    {
      id: "OBS-payments-errors",
      service: "payments",
      metric: "payment_authorization_error_rate",
      value: 8.7,
      threshold: 2,
      window: "30m",
      status: "breaching",
      risk: "error-budget",
    },
    {
      id: "OBS-checkout-latency",
      service: "checkout",
      metric: "checkout_p95_latency",
      value: 640,
      threshold: 500,
      window: "30m",
      status: "watch",
      risk: "shift-handoff",
    },
    {
      id: "OBS-search-lag",
      service: "search-indexer",
      metric: "index_lag_seconds",
      value: 45,
      threshold: 120,
      window: "30m",
      status: "normal",
      risk: "low",
    },
  ],
  featureFlags: [
    {
      id: "flag-payments-token-refresh-v2",
      service: "payments",
      state: "disabled",
      releaseId: "REL-4419",
      safeState: "disabled",
      reason: "Disabled during token refresh incident.",
    },
    {
      id: "flag-search-personalization",
      service: "search-indexer",
      state: "enabled",
      releaseId: "REL-4408",
      safeState: "enabled",
      reason: "Distractor flag.",
    },
  ],
  memory: [
    {
      id: "mem-northstar-owner",
      key: "Northstar Bank executive owner",
      value: "Maya Chen",
      summary: "Maya Chen owns executive renewal escalation for Northstar Bank.",
    },
    {
      id: "mem-payments-owner",
      key: "payments incident owner",
      value: "payments-platform",
      summary: "Payments incidents page payments-platform first.",
    },
  ],
  files: [
    {
      id: "handoff/current.md",
      path: "handoff/current.md",
      summary:
        "Next shift covers 2026-06-10T20:00:00Z/2026-06-11T08:00:00Z. Watch payments and checkout.",
    },
    {
      id: "runbooks/payments-rollback.md",
      path: "runbooks/payments-rollback.md",
      summary: "Stale rollback notes for REL-4419. Last reviewed 2026-05-01.",
    },
    {
      id: "notes/search-indexer.md",
      path: "notes/search-indexer.md",
      summary: "Search-indexer is stable. Distractor file.",
    },
  ],
  repo: [
    {
      id: "repo-status",
      branch: "main",
      dirty: false,
      unmergedFixes: ["GH-8842"],
      riskyServices: ["payments", "checkout"],
      summary: "Clean tree with one unmerged payments fix and checkout watch item.",
    },
  ],
  browser: [
    {
      id: "dash-incident",
      url: "http://localhost/noauth/incident",
      title: "Incident dashboard snapshot",
      summary: "Local dashboard snapshot shows INC-9071 active and payments error budget red.",
    },
  ],
};

const serverData: Record<string, () => any[]> = {
  repo: () => records.repo,
  filesystem: () => records.files,
  sqlite: () => [
    ...records.customers.map((row) => ({ table: "renewals", ...row })),
    ...records.jira.map((row) => ({ table: "blockers", ...row })),
  ],
  docs: () => records.docs,
  browser: () => records.browser,
  memory: () => records.memory,
  time: () => [{ id: "now", now: "2026-06-10T19:36:00Z", nextShiftStart: "2026-06-10T20:00:00Z" }],
  slack: () => records.slack,
  jira: () => records.jira,
  github: () => records.github,
  observability: () => records.observability,
  deployments: () => records.releases,
  feature_flags: () => records.featureFlags,
  customers: () => records.customers,
  incidents: () => records.incidents,
};

const serverToolNames: Record<string, string[]> = {
  repo: ["search", "status", "get", "list", "read", "summarize", "inspect", "diff"],
  filesystem: ["search", "read", "get", "list", "summarize", "inspect", "stat", "glob"],
  sqlite: ["search", "query", "get", "list", "summarize", "inspect", "schema", "explain"],
  docs: ["search", "get", "list", "read", "summarize", "inspect", "related", "render"],
  browser: ["search", "get", "list", "read", "summarize", "inspect", "snapshot", "click"],
  memory: ["search", "get", "list", "read", "summarize", "inspect", "remember", "forget"],
  time: ["search", "now", "convert", "list", "get", "summarize", "inspect", "zone"],
  slack: ["search", "get", "list", "read", "summarize", "inspect", "thread", "channels"],
  jira: ["search", "get", "list", "read", "summarize", "inspect", "transitions", "comments"],
  github: ["search", "get", "list", "read", "summarize", "inspect", "diff", "checks"],
  observability: ["search", "query", "get", "list", "summarize", "inspect", "logs", "metrics"],
  deployments: ["search", "get", "list", "read", "summarize", "inspect", "rollback", "approvals"],
  feature_flags: ["search", "get", "list", "read", "summarize", "inspect", "evaluate", "audit"],
  customers: [
    "search",
    "get",
    "list",
    "read",
    "summarize",
    "inspect",
    "impact_summary",
    "renewals",
  ],
  incidents: ["search", "get", "list", "read", "summarize", "inspect", "timeline", "affected"],
};

export const TOOLSETS: Record<string, any[]> = Object.fromEntries(
  SERVER_NAMES.map((serverName) => [
    serverName,
    serverToolNames[serverName].map((toolName) => createTool(serverName, toolName)),
  ]),
);

export const listToolMetadata = (serverName: string) => {
  const validServerName = validateServerName(serverName);
  return TOOLSETS[validServerName].map(({ name, title, description, metadataInputSchema }) => ({
    server: validServerName,
    name,
    title,
    description,
    inputSchema: metadataInputSchema,
    annotations: readOnlyAnnotations,
  }));
};

export function createMockMcpServer(serverName: string) {
  const validServerName = validateServerName(serverName);
  return {
    connect: () => startStdioMcpServer(validServerName),
  };
}

function createTool(serverName: string, toolName: string) {
  return {
    name: toolName,
    title: `${serverName} ${toolName}`.replaceAll("_", " "),
    description: toolDescription(serverName, toolName),
    inputSchema: schemaForTool(toolName),
    metadataInputSchema: schemaForTool(toolName),
    handler: (args: any) => handleTool(serverName, toolName, args),
  };
}

function toolDescription(serverName: string, toolName: string) {
  return [
    `${toolName} records in the ${serverName} no-auth fixture server.`,
    "No API key is required.",
    "The data shape mirrors common SaaS, DevOps, incident, docs, repo, browser, SQL, memory, and collaboration MCP servers.",
  ].join(" ");
}

function schemaForTool(toolName: string) {
  if (toolName === "query") return sqlSchema;
  if (toolName === "convert") return timeSchema;
  if (["search", "logs", "metrics", "glob", "explain"].includes(toolName)) return querySchema;
  if (["list", "now", "status", "schema", "channels", "zone"].includes(toolName))
    return emptySchema;
  return idSchema;
}

function handleTool(serverName: string, toolName: string, args: any) {
  if (serverName === "time" && toolName === "now") {
    return asResult("Current fixture time", {
      now: "2026-06-10T19:36:00Z",
      nextShift: {
        start: "2026-06-10T20:00:00Z",
        end: "2026-06-11T08:00:00Z",
        window: "2026-06-10T20:00:00Z/2026-06-11T08:00:00Z",
      },
    });
  }
  if (serverName === "time" && toolName === "convert") {
    return asResult("Converted fixture time", {
      from: args.from ?? "2026-06-10T20:00:00Z",
      toZone: args.toZone ?? "UTC",
      value: args.from ?? "2026-06-10T20:00:00Z",
    });
  }
  if (serverName === "repo" && toolName === "status") {
    return asResult("Repository status", records.repo[0]);
  }
  if (serverName === "customers" && toolName === "impact_summary") {
    const incident = records.incidents.find((entry) => entry.id === (args.id ?? "INC-9071"));
    const accounts = records.customers.filter((account) =>
      incident?.affectedAccountIds.includes(account.id),
    );
    return asResult("Customer impact summary", {
      incidentId: incident?.id ?? args.id,
      affectedEnterpriseAccounts: accounts.filter((account) => account.tier === "enterprise")
        .length,
      impactedRegions: [...new Set(accounts.map((account) => account.region))].sort(),
      accounts,
    });
  }
  if (serverName === "sqlite" && toolName === "query") {
    return asResult("SQLite query result", sqliteQuery(args.sql ?? ""));
  }
  if (serverName === "observability" && toolName === "query") {
    return asResult("Observability query result", {
      query: args.query ?? "",
      series: searchRecords(records.observability, args.query ?? ""),
      releaseRisk: { releaseId: "REL-4419", blocker: "error-budget", status: "breaching" },
    });
  }

  const data = serverData[serverName]?.() ?? [];
  if (toolName === "search") {
    return asResult(`${serverName} search results`, {
      query: args.query ?? "",
      results: searchRecords(data, args.query ?? ""),
    });
  }
  if (toolName === "list") return asResult(`${serverName} list`, { records: compactRecords(data) });
  if (toolName === "summarize")
    return asResult(`${serverName} summary`, summarizeServer(serverName));
  if (toolName === "inspect")
    return asResult(`${serverName} inspection`, {
      serverName,
      tools: serverToolNames[serverName],
      records: data.length,
    });

  const found = getRecord(data, args.id) ?? getSpecialRecord(serverName, toolName, args.id);
  return asResult(
    `${serverName} ${toolName}`,
    found ?? { id: args.id ?? null, records: compactRecords(data) },
  );
}

function sqliteQuery(sql: string) {
  const lowered = sql.toLowerCase();
  const renewalRows = records.customers.map((row) => ({
    account: row.name,
    arr: row.arr,
    renewal_status: row.renewalStatus,
    renewal_date: row.renewalDate,
    executive_owner: row.executiveOwner,
  }));
  if (lowered.includes("northstar") || lowered.includes("arr") || lowered.includes("renewal")) {
    return {
      columns: ["account", "arr", "renewal_status", "renewal_date", "executive_owner"],
      rows: renewalRows.sort((a, b) => b.arr - a.arr),
    };
  }
  return {
    columns: ["id", "title", "blocker"],
    rows: records.jira.map(({ id, title, blocker }) => ({ id, title, blocker })),
  };
}

function summarizeServer(serverName: string) {
  if (serverName === "incidents") {
    return {
      activeIncidentCount: records.incidents.filter((incident) => incident.status === "active")
        .length,
      active: records.incidents.filter((incident) => incident.status === "active"),
    };
  }
  if (serverName === "deployments") {
    return {
      currentRelease: "REL-4419",
      holdReasons: ["GH-8842", "JIRA-PAY-317", "error-budget"],
    };
  }
  if (serverName === "customers") {
    return {
      largestUpcomingRenewal: "Northstar Bank",
      atRiskEnterpriseAccounts: records.customers.filter(
        (account) => account.tier === "enterprise" && account.renewalStatus === "at-risk",
      ),
    };
  }
  return { serverName, recordCount: serverData[serverName]?.().length ?? 0 };
}

function getSpecialRecord(serverName: string, toolName: string, id: string | undefined) {
  if (serverName === "docs" && id === "runbooks/payments-rollback.md") {
    return records.docs.find((record) => record.path === id);
  }
  if (
    serverName === "filesystem" &&
    toolName === "read" &&
    id === "runbooks/payments-rollback.md"
  ) {
    return records.files.find((record) => record.path === id);
  }
  return null;
}

function getRecord(data: any[], id: string | undefined) {
  if (!id) return null;
  return data.find(
    (record) =>
      record.id === id ||
      record.path === id ||
      record.name === id ||
      record.key === id ||
      record.service === id ||
      record.releaseId === id,
  );
}

function searchRecords(data: any[], query = "") {
  if (!query) return compactRecords(data);
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9-]+/u)
    .filter(Boolean);
  if (terms.length === 0) return compactRecords(data);
  return compactRecords(
    data.filter((record) => {
      const text = JSON.stringify(record).toLowerCase();
      return terms.some((term) => text.includes(term));
    }),
  );
}

function compactRecords(data: any[]) {
  return data.slice(0, 20);
}

const asResult = (summary: string, data: unknown) => ({
  content: [{ type: "text", text: `${summary}\n${JSON.stringify(data, null, 2)}` }],
  structuredContent: data,
});

function validateServerName(serverName: string) {
  if (!SERVER_NAMES.includes(serverName)) {
    throw new Error(`Unknown --server ${serverName}. Expected one of: ${SERVER_NAMES.join(", ")}`);
  }
  return serverName;
}

function startStdioMcpServer(serverName: string) {
  const tools = TOOLSETS[serverName];
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;

    while (buffer.length > 0) {
      const trimmed = buffer.trimStart();
      const leadingWhitespaceLength = buffer.length - trimmed.length;
      if (leadingWhitespaceLength > 0) buffer = trimmed;

      if (/^Content-Length:/iu.test(buffer)) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        const fallbackHeaderEnd = headerEnd === -1 ? buffer.indexOf("\n\n") : -1;
        const effectiveHeaderEnd = headerEnd === -1 ? fallbackHeaderEnd : headerEnd;
        if (effectiveHeaderEnd === -1) return;

        const headerText = buffer.slice(0, effectiveHeaderEnd);
        const lengthMatch = /^Content-Length:\s*(\d+)\s*$/imu.exec(headerText);
        if (!lengthMatch) {
          writeMcpMessage(
            { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
            "framed",
          );
          buffer = "";
          return;
        }

        const bodyStart = effectiveHeaderEnd + (headerEnd === -1 ? 2 : 4);
        const contentLength = Number(lengthMatch[1]);
        if (buffer.length < bodyStart + contentLength) return;

        const body = buffer.slice(bodyStart, bodyStart + contentLength);
        buffer = buffer.slice(bodyStart + contentLength);
        dispatchMcpMessage(serverName, tools, body, "framed");
        continue;
      }

      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) dispatchMcpMessage(serverName, tools, line, "line");
    }
  });
}

function dispatchMcpMessage(serverName: string, tools: any[], raw: string, protocol: string) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    writeMcpMessage(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      protocol,
    );
    return;
  }
  handleMcpMessage(serverName, tools, message, protocol);
}

function handleMcpMessage(serverName: string, tools: any[], message: any, protocol = "line") {
  if (message.id === undefined || String(message.method).startsWith("notifications/")) return;

  try {
    if (message.method === "initialize") {
      writeMcpMessage(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: `benchmark-realistic-${serverName}`, version: "1.0.0" },
          },
        },
        protocol,
      );
      return;
    }

    if (message.method === "tools/list") {
      writeMcpMessage(
        { jsonrpc: "2.0", id: message.id, result: { tools: listToolMetadata(serverName) } },
        protocol,
      );
      return;
    }

    if (message.method === "tools/call") {
      const tool = tools.find(({ name }) => name === message.params?.name);
      if (!tool) throw new Error(`Unknown tool ${message.params?.name}`);
      writeMcpMessage(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: tool.handler(message.params?.arguments ?? {}),
        },
        protocol,
      );
      return;
    }

    throw new Error(`Unsupported MCP method ${message.method}`);
  } catch (error) {
    writeMcpMessage(
      {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      },
      protocol,
    );
  }
}

function writeMcpMessage(message: any, protocol = "line") {
  const payload = JSON.stringify(message);
  if (protocol === "framed") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
    return;
  }
  process.stdout.write(`${payload}\n`);
}

function parseArgs(argv: string[]) {
  const serverFlagIndex = argv.indexOf("--server");
  const serverName = serverFlagIndex === -1 ? "repo" : argv[serverFlagIndex + 1];

  return {
    serverName,
    listTools: argv.includes("--list-tools"),
  };
}

async function main() {
  const { serverName, listTools } = parseArgs(process.argv.slice(2));
  const validServerName = validateServerName(serverName);

  if (listTools) {
    console.log(JSON.stringify(listToolMetadata(validServerName), null, 2));
    return;
  }

  await createMockMcpServer(validServerName).connect();
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  realpathOrResolved(fileURLToPath(import.meta.url)) === realpathOrResolved(process.argv[1]);

function realpathOrResolved(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
