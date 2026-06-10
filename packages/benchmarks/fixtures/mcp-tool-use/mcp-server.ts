import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_NAMES = [
  "api_catalog",
  "incidents",
  "customers",
  "deployments",
  "quality",
  "policies",
];

const emptySchema = { type: "object", properties: {}, additionalProperties: false };
const querySchema = {
  type: "object",
  properties: { query: { type: "string", description: "Search query." } },
  additionalProperties: false,
};
const idSchema = {
  type: "object",
  properties: { id: { type: "string", description: "Record identifier." } },
  required: ["id"],
  additionalProperties: false,
};
const releaseIdSchema = {
  type: "object",
  properties: { releaseId: { type: "string", description: "Release identifier." } },
  required: ["releaseId"],
  additionalProperties: false,
};
const idsSchema = {
  type: "object",
  properties: {
    ids: { type: "array", items: { type: "string" }, description: "Record identifiers." },
  },
  required: ["ids"],
  additionalProperties: false,
};
const operationDetailSchema = {
  type: "object",
  properties: {
    operation: {
      type: "object",
      properties: {
        id: { type: "string", description: "Operation identifier." },
        includeExamples: { type: "boolean", description: "Include compact examples." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  required: ["operation"],
  additionalProperties: false,
};
const readOnlyAnnotations = { readOnlyHint: true, idempotentHint: true };

const API_GROUPS = [
  {
    id: "products",
    title: "Products API",
    summary: "Product catalog search and legacy list operations.",
    operations: ["products.search", "products.list_legacy", "products.autocomplete"],
  },
  {
    id: "customers",
    title: "Customers API",
    summary: "Customer account list and profile lookup operations.",
    operations: ["customers.list", "customers.get", "customers.search_notes"],
  },
  {
    id: "audit",
    title: "Audit API",
    summary: "Audit event retrieval for compliance exports.",
    operations: ["audit.events", "audit.event_detail"],
  },
  {
    id: "orders",
    title: "Orders API",
    summary: "Distractor order export operations.",
    operations: ["orders.export", "orders.get"],
  },
];

const API_OPERATIONS = [
  {
    id: "products.search",
    api: "products",
    method: "GET",
    path: "/v2/products/search",
    paginated: true,
    paginationStyle: "cursor",
    requiredParameters: ["query", "page_size", "cursor"],
    resultFields: ["items", "next_cursor"],
    summary: "Search products with cursor pagination.",
  },
  {
    id: "products.list_legacy",
    api: "products",
    method: "GET",
    path: "/v1/products",
    paginated: false,
    paginationStyle: "none",
    requiredParameters: ["category"],
    resultFields: ["items"],
    summary: "Legacy list endpoint that returns a fixed sample and is not paginated.",
  },
  {
    id: "products.autocomplete",
    api: "products",
    method: "GET",
    path: "/v2/products/autocomplete",
    paginated: false,
    paginationStyle: "none",
    requiredParameters: ["prefix"],
    resultFields: ["suggestions"],
    summary: "Autocomplete endpoint, not part of pagination audit.",
  },
  {
    id: "customers.list",
    api: "customers",
    method: "GET",
    path: "/v2/customers",
    paginated: true,
    paginationStyle: "offset",
    requiredParameters: ["limit", "offset"],
    resultFields: ["customers", "total"],
    summary: "List customers with limit and offset pagination.",
  },
  {
    id: "customers.get",
    api: "customers",
    method: "GET",
    path: "/v2/customers/{id}",
    paginated: false,
    paginationStyle: "none",
    requiredParameters: ["id"],
    resultFields: ["customer"],
    summary: "Fetch one customer.",
  },
  {
    id: "customers.search_notes",
    api: "customers",
    method: "GET",
    path: "/v2/customers/notes/search",
    paginated: false,
    paginationStyle: "none",
    requiredParameters: ["query"],
    resultFields: ["notes"],
    summary: "Distractor note search without pagination controls.",
  },
  {
    id: "audit.events",
    api: "audit",
    method: "GET",
    path: "/v1/audit/events",
    paginated: true,
    paginationStyle: "time_window",
    requiredParameters: ["start_time", "end_time", "next_token"],
    resultFields: ["events", "next_token"],
    summary: "Read audit events with a bounded time window and continuation token.",
  },
  {
    id: "audit.event_detail",
    api: "audit",
    method: "GET",
    path: "/v1/audit/events/{id}",
    paginated: false,
    paginationStyle: "none",
    requiredParameters: ["id"],
    resultFields: ["event"],
    summary: "Fetch one audit event.",
  },
  {
    id: "orders.export",
    api: "orders",
    method: "POST",
    path: "/v2/orders/export",
    paginated: false,
    paginationStyle: "none",
    requiredParameters: ["format"],
    resultFields: ["jobId"],
    summary: "Distractor export endpoint.",
  },
];

const INCIDENTS = [
  {
    id: "INC-2026-0610-1",
    title: "Checkout latency elevated",
    status: "resolved",
    severity: "sev3",
    service: "checkout",
    affectedAccountIds: ["acct-acme-retail"],
    summary: "Resolved incident with stale customer impact.",
  },
  {
    id: "INC-2026-0610-2",
    title: "Payments API partial outage",
    status: "active",
    severity: "sev1",
    service: "payments",
    affectedAccountIds: ["acct-atlas", "acct-beacon", "acct-crane", "acct-delta"],
    summary: "Active payments incident requiring customer impact join.",
  },
  {
    id: "INC-2026-0610-3",
    title: "Search indexing delay",
    status: "monitoring",
    severity: "sev2",
    service: "search",
    affectedAccountIds: ["acct-ember"],
    summary: "Distractor monitoring incident.",
  },
];

const CUSTOMERS = [
  {
    id: "acct-atlas",
    name: "Atlas Freight",
    tier: "enterprise",
    region: "na",
    escalationTarget: "atlas-oncall",
  },
  {
    id: "acct-beacon",
    name: "Beacon Health",
    tier: "enterprise",
    region: "eu",
    escalationTarget: "beacon-csm",
  },
  {
    id: "acct-crane",
    name: "Crane Labs",
    tier: "growth",
    region: "na",
    escalationTarget: "crane-support",
  },
  {
    id: "acct-delta",
    name: "Delta Apps",
    tier: "startup",
    region: "apac",
    escalationTarget: "crane-support",
  },
  {
    id: "acct-acme-retail",
    name: "Acme Retail",
    tier: "growth",
    region: "na",
    escalationTarget: "acme-csm",
  },
  {
    id: "acct-ember",
    name: "Ember Search",
    tier: "startup",
    region: "eu",
    escalationTarget: "ember-support",
  },
];

const RELEASES = [
  {
    id: "REL-2026-06-10-payments",
    service: "payments",
    version: "2026.06.10",
    environment: "production",
    status: "pending_approval",
    riskScore: 78,
    qualityRunId: "QR-778",
    summary: "Payments release pending final readiness decision.",
  },
  {
    id: "REL-2026-06-10-search",
    service: "search",
    version: "2026.06.10",
    environment: "production",
    status: "approved",
    riskScore: 32,
    qualityRunId: "QR-779",
    summary: "Distractor release for search.",
  },
  {
    id: "REL-2026-06-09-payments",
    service: "payments",
    version: "2026.06.09",
    environment: "staging",
    status: "deployed",
    riskScore: 41,
    qualityRunId: "QR-770",
    summary: "Older payments staging release.",
  },
];

const QUALITY_CHECKS = [
  {
    id: "contract-tests",
    releaseId: "REL-2026-06-10-payments",
    status: "fail",
    severity: "blocking",
    detail: "Partner contract suite failed for refund webhook schema.",
  },
  {
    id: "rollback-plan",
    releaseId: "REL-2026-06-10-payments",
    status: "warning",
    severity: "blocking",
    detail: "Rollback plan is older than policy maximum.",
  },
  {
    id: "load-test",
    releaseId: "REL-2026-06-10-payments",
    status: "pass",
    severity: "required",
    detail: "Load test passed at 2x expected traffic.",
  },
  {
    id: "security-scan",
    releaseId: "REL-2026-06-10-payments",
    status: "skipped",
    severity: "covered_by_exception",
    detail: "Covered by valid exception EXC-442.",
  },
  {
    id: "contract-tests",
    releaseId: "REL-2026-06-10-search",
    status: "pass",
    severity: "required",
    detail: "Search contract tests passed.",
  },
];

const RELEASE_POLICY = {
  id: "payments-release-policy",
  service: "payments",
  riskScoreBlockThreshold: 70,
  blockingStatuses: ["fail"],
  warningBlockers: ["rollback-plan"],
  validExceptionStates: ["approved"],
  maxRollbackPlanAgeHours: 24,
  summary:
    "Production payments releases are blocked when risk score exceeds 70, a blocking check fails, or rollback-plan warning is not covered by a valid scoped exception.",
};

const EXCEPTIONS = [
  {
    id: "EXC-442",
    releaseId: "REL-2026-06-10-payments",
    checkId: "security-scan",
    status: "approved",
    expiresAt: "2026-06-12T00:00:00Z",
    scope: "payments",
    summary: "Approved scoped exception for skipped security scan.",
  },
  {
    id: "EXC-410",
    releaseId: "REL-2026-06-10-payments",
    checkId: "contract-tests",
    status: "expired",
    expiresAt: "2026-06-01T00:00:00Z",
    scope: "payments",
    summary: "Expired exception that must not unblock contract tests.",
  },
  {
    id: "EXC-499",
    releaseId: "REL-2026-06-10-payments",
    checkId: "rollback-plan",
    status: "approved",
    expiresAt: "2026-06-12T00:00:00Z",
    scope: "search",
    summary: "Wrong-service exception that must not unblock payments release.",
  },
];

const asResult = (summary: string, data: unknown) => ({
  content: [{ type: "text", text: `${summary}\n${JSON.stringify(data, null, 2)}` }],
  structuredContent: data,
});

const matchText = (value: unknown, query = "") =>
  !query || JSON.stringify(value).toLowerCase().includes(query.toLowerCase());

const summarizeAccounts = (accounts: typeof CUSTOMERS) => ({
  affectedAccountCount: accounts.length,
  tierBreakdown: countBy(accounts, "tier"),
  regionBreakdown: countBy(accounts, "region"),
  escalationTargets: [...new Set(accounts.map((account) => account.escalationTarget))].sort(),
});

function countBy<T extends Record<string, any>>(records: T[], key: keyof T) {
  return records.reduce<Record<string, number>>((counts, record) => {
    const value = String(record[key]);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

const apiCatalogTools = [
  {
    name: "search_apis",
    title: "Search APIs",
    description: "Search API groups and operations by product area, path, or pagination detail.",
    inputSchema: querySchema,
    metadataInputSchema: querySchema,
    handler: ({ query = "" }) =>
      asResult("API catalog search results", {
        query,
        results: API_GROUPS.filter((group) => matchText(group, query)).map(
          ({ id, title, summary, operations }) => ({ id, title, summary, operations }),
        ),
      }),
  },
  {
    name: "list_operations",
    title: "List Operations",
    description:
      "List compact operation records across product, customer, audit, and distractor APIs.",
    inputSchema: emptySchema,
    metadataInputSchema: emptySchema,
    handler: () =>
      asResult("API operations", {
        operations: API_OPERATIONS.map(({ id, api, method, path, summary }) => ({
          id,
          api,
          method,
          path,
          summary,
        })),
      }),
  },
  {
    name: "get_operation",
    title: "Get Operation",
    description: "Fetch detailed operation metadata. Arguments are nested under operation.id.",
    inputSchema: operationDetailSchema,
    metadataInputSchema: operationDetailSchema,
    handler: ({ operation }: any) => {
      const record = API_OPERATIONS.find((entry) => entry.id === operation?.id);
      return asResult("API operation detail", record ?? { id: operation?.id, error: "not found" });
    },
  },
  {
    name: "compare_operations",
    title: "Compare Operations",
    description: "Return a compact pagination comparison for selected operation ids.",
    inputSchema: idsSchema,
    metadataInputSchema: idsSchema,
    handler: ({ ids }: any) =>
      asResult("API operation comparison", {
        operations: API_OPERATIONS.filter((entry) => ids.includes(entry.id)).map(
          ({ id, paginated, paginationStyle, requiredParameters }) => ({
            id,
            paginated,
            paginationStyle,
            requiredParameters,
          }),
        ),
      }),
  },
  ...["orders_export_help", "auth_scopes", "webhook_catalog", "rate_limits"].map((name) => ({
    name,
    title: name.replaceAll("_", " "),
    description: "Distractor API catalog reference.",
    inputSchema: emptySchema,
    metadataInputSchema: emptySchema,
    handler: () => asResult("API distractor", { id: name, relevantToTask: false }),
  })),
];

const incidentTools = [
  {
    name: "search_incidents",
    title: "Search Incidents",
    description: "Search incidents by title, status, severity, or service.",
    inputSchema: querySchema,
    metadataInputSchema: querySchema,
    handler: ({ query = "" }) =>
      asResult("Incident search results", {
        query,
        results: INCIDENTS.filter((incident) => matchText(incident, query)).map(
          ({ id, title, status, severity, service, summary }) => ({
            id,
            title,
            status,
            severity,
            service,
            summary,
          }),
        ),
      }),
  },
  {
    name: "get_incident",
    title: "Get Incident",
    description: "Fetch incident details, including affected account ids.",
    inputSchema: idSchema,
    metadataInputSchema: idSchema,
    handler: ({ id }: any) =>
      asResult(
        "Incident detail",
        INCIDENTS.find((incident) => incident.id === id) ?? { id, error: "incident not found" },
      ),
  },
  {
    name: "list_affected_accounts",
    title: "List Affected Accounts",
    description: "Return affected account ids for an incident.",
    inputSchema: idSchema,
    metadataInputSchema: idSchema,
    handler: ({ id }: any) => {
      const incident = INCIDENTS.find((entry) => entry.id === id);
      return asResult("Affected account ids", {
        incidentId: id,
        accountIds: incident?.affectedAccountIds ?? [],
      });
    },
  },
  {
    name: "incident_metrics",
    title: "Incident Metrics",
    description: "Distractor incident metrics.",
    inputSchema: emptySchema,
    metadataInputSchema: emptySchema,
    handler: () => asResult("Incident metrics", { relevantToTask: false, count: 3 }),
  },
];

const customerTools = [
  {
    name: "get_accounts",
    title: "Get Accounts",
    description: "Fetch customer accounts by id in one batch.",
    inputSchema: idsSchema,
    metadataInputSchema: idsSchema,
    handler: ({ ids }: any) =>
      asResult("Customer accounts", {
        accounts: CUSTOMERS.filter((account) => ids.includes(account.id)),
      }),
  },
  {
    name: "summarize_accounts",
    title: "Summarize Accounts",
    description: "Summarize customer tiers, regions, and escalation targets for account ids.",
    inputSchema: idsSchema,
    metadataInputSchema: idsSchema,
    handler: ({ ids }: any) => {
      const accounts = CUSTOMERS.filter((account) => ids.includes(account.id));
      return asResult("Customer account summary", summarizeAccounts(accounts));
    },
  },
  {
    name: "search_accounts",
    title: "Search Accounts",
    description: "Search account records by name, tier, region, or escalation target.",
    inputSchema: querySchema,
    metadataInputSchema: querySchema,
    handler: ({ query = "" }) =>
      asResult("Customer search results", {
        query,
        results: CUSTOMERS.filter((customer) => matchText(customer, query)),
      }),
  },
  {
    name: "account_health",
    title: "Account Health",
    description: "Distractor account health rollup.",
    inputSchema: emptySchema,
    metadataInputSchema: emptySchema,
    handler: () => asResult("Account health", { relevantToTask: false }),
  },
];

const deploymentTools = [
  {
    name: "list_releases",
    title: "List Releases",
    description: "List release records by current deployment status.",
    inputSchema: emptySchema,
    metadataInputSchema: emptySchema,
    handler: () =>
      asResult("Releases", {
        releases: RELEASES.map(({ id, service, version, environment, status, summary }) => ({
          id,
          service,
          version,
          environment,
          status,
          summary,
        })),
      }),
  },
  {
    name: "get_release",
    title: "Get Release",
    description: "Fetch release readiness context by release id.",
    inputSchema: idSchema,
    metadataInputSchema: idSchema,
    handler: ({ id }: any) =>
      asResult(
        "Release detail",
        RELEASES.find((release) => release.id === id) ?? { id, error: "release not found" },
      ),
  },
];

const qualityTools = [
  {
    name: "list_checks",
    title: "List Checks",
    description: "List quality checks for a release id.",
    inputSchema: releaseIdSchema,
    metadataInputSchema: releaseIdSchema,
    handler: ({ releaseId }: any) =>
      asResult("Quality checks", {
        releaseId,
        checks: QUALITY_CHECKS.filter((check) => check.releaseId === releaseId),
      }),
  },
  {
    name: "get_check_details",
    title: "Get Check Details",
    description: "Fetch details for one quality check id.",
    inputSchema: idSchema,
    metadataInputSchema: idSchema,
    handler: ({ id }: any) =>
      asResult(
        "Quality check detail",
        QUALITY_CHECKS.find((check) => check.id === id) ?? { id, error: "check not found" },
      ),
  },
];

const policyTools = [
  {
    name: "get_release_policy",
    title: "Get Release Policy",
    description: "Fetch release policy thresholds and blocker interpretation.",
    inputSchema: idSchema,
    metadataInputSchema: idSchema,
    handler: ({ id }: any) =>
      asResult("Release policy", id === RELEASE_POLICY.service ? RELEASE_POLICY : RELEASE_POLICY),
  },
  {
    name: "list_exceptions",
    title: "List Exceptions",
    description: "List release policy exceptions scoped to a release.",
    inputSchema: releaseIdSchema,
    metadataInputSchema: releaseIdSchema,
    handler: ({ releaseId }: any) =>
      asResult("Policy exceptions", {
        releaseId,
        exceptions: EXCEPTIONS.filter((exception) => exception.releaseId === releaseId),
      }),
  },
  {
    name: "risk_thresholds",
    title: "Risk Thresholds",
    description: "Distractor policy summary with incomplete exception context.",
    inputSchema: emptySchema,
    metadataInputSchema: emptySchema,
    handler: () =>
      asResult("Risk thresholds", {
        riskScoreBlockThreshold: RELEASE_POLICY.riskScoreBlockThreshold,
        incomplete: true,
      }),
  },
];

export const TOOLSETS: Record<string, any[]> = {
  api_catalog: apiCatalogTools,
  incidents: incidentTools,
  customers: customerTools,
  deployments: deploymentTools,
  quality: qualityTools,
  policies: policyTools,
};

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
            serverInfo: { name: `benchmark-${serverName}`, version: "1.0.0" },
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
  const serverName = serverFlagIndex === -1 ? "api_catalog" : argv[serverFlagIndex + 1];

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
