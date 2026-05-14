#!/usr/bin/env node

export const SERVER_NAMES = ["policy", "tickets", "api"];

const DISCOUNT_POLICY = {
  id: "discount-policy",
  title: "Customer discount policy",
  version: "2026-05-14",
  facts: [
    "Premium customers receive 15% off only when the cart total is at least 100.",
    "Employees receive 25% off regardless of total.",
    "Discounts are rounded to two decimal places.",
  ],
};

const RETRY_POLICY = {
  id: "retry-policy",
  title: "HTTP retry scheduling policy",
  version: "2026-05-14",
  facts: [
    "Retry delays are 100ms, 250ms, and 500ms for attempts 1 through 3.",
    "Retryable status codes are 408, 429, 500, 502, 503, and 504.",
    "Attempts after the third failure must not be scheduled.",
  ],
};

const TICKETS = [
  {
    id: "BENCH-101",
    title: "Discount calculation regression",
    status: "ready",
    summary: "Premium discount currently applies below the policy threshold.",
  },
  {
    id: "BENCH-102",
    title: "Retry scheduler uses stale backoff table",
    status: "ready",
    summary: "Retry attempts should follow the current platform retry policy.",
  },
  {
    id: "BENCH-210",
    title: "Invoice export polish",
    status: "backlog",
    summary: "Distractor ticket unrelated to the coding benchmark tasks.",
  },
];

const API_SCHEMAS = [
  {
    id: "discount-request",
    method: "POST",
    path: "/internal/discounts/calculate",
    fields: ["customerType", "cartTotal", "currency"],
  },
  {
    id: "retry-decision",
    method: "POST",
    path: "/internal/retries/decision",
    fields: ["attempt", "statusCode", "method"],
  },
  {
    id: "ticket-event",
    method: "POST",
    path: "/internal/tickets/events",
    fields: ["ticketId", "eventType", "actor"],
  },
];

const emptyJsonSchema = { type: "object", properties: {}, additionalProperties: false };
const queryJsonSchema = {
  type: "object",
  properties: { query: { type: "string", description: "Search query." } },
  additionalProperties: false,
};
const idJsonSchema = {
  type: "object",
  properties: { id: { type: "string", description: "Record identifier." } },
  required: ["id"],
  additionalProperties: false,
};
const emptySchema = emptyJsonSchema;
const querySchema = queryJsonSchema;
const idSchema = idJsonSchema;
const readOnlyAnnotations = { readOnlyHint: true, idempotentHint: true };

function validateServerName(serverName) {
  if (!SERVER_NAMES.includes(serverName)) {
    throw new Error(`Unknown --server ${serverName}. Expected one of: ${SERVER_NAMES.join(", ")}`);
  }

  return serverName;
}

const asResult = (summary, data) => ({
  content: [{ type: "text", text: `${summary}\n${JSON.stringify(data, null, 2)}` }],
  structuredContent: data,
});

const matchText = (value, query) => !query || value.toLowerCase().includes(query.toLowerCase());

const findPolicy = (id) =>
  [DISCOUNT_POLICY, RETRY_POLICY].find(
    (policy) => policy.id === id || policy.title.toLowerCase().includes(id.toLowerCase()),
  );

const policyTools = [
  {
    name: "search",
    title: "Search Policies",
    description: "Search current engineering and product policies by keyword.",
    inputSchema: querySchema,
    metadataInputSchema: queryJsonSchema,
    handler: ({ query = "" }) =>
      asResult("Policy search results", {
        query,
        results: [DISCOUNT_POLICY, RETRY_POLICY]
          .filter((policy) =>
            matchText(`${policy.id} ${policy.title} ${policy.facts.join(" ")}`, query),
          )
          .map(({ id, title, version }) => ({ id, title, version })),
      }),
  },
  {
    name: "get",
    title: "Get Policy",
    description: "Read a policy by id, including the benchmark-critical facts.",
    inputSchema: idSchema,
    metadataInputSchema: idJsonSchema,
    handler: ({ id }) =>
      asResult("Policy record", findPolicy(id) ?? { id, error: "policy not found" }),
  },
  {
    name: "read_policy",
    title: "Read Policy",
    description: "Alias for retrieving a policy document by id.",
    inputSchema: idSchema,
    metadataInputSchema: idJsonSchema,
    handler: ({ id }) =>
      asResult("Policy document", findPolicy(id) ?? { id, error: "policy not found" }),
  },
  {
    name: "policy_search",
    title: "Policy Search",
    description: "Search policy documents with domain-specific naming.",
    inputSchema: querySchema,
    metadataInputSchema: queryJsonSchema,
    handler: ({ query = "" }) =>
      asResult("Policy search results", {
        query,
        results: [DISCOUNT_POLICY, RETRY_POLICY].filter((policy) =>
          matchText(`${policy.id} ${policy.title} ${policy.facts.join(" ")}`, query),
        ),
      }),
  },
  {
    name: "policy_get",
    title: "Policy Get",
    description: "Fetch exact policy facts required by implementation tasks.",
    inputSchema: idSchema,
    metadataInputSchema: idJsonSchema,
    handler: ({ id }) =>
      asResult("Policy facts", findPolicy(id) ?? { id, error: "policy not found" }),
  },
  {
    name: "discount_policy",
    title: "Discount Policy",
    description: "Return the current customer discount rules.",
    inputSchema: emptySchema,
    metadataInputSchema: emptyJsonSchema,
    handler: () => asResult("Discount policy", DISCOUNT_POLICY),
  },
  {
    name: "retry_policy",
    title: "Retry Policy",
    description: "Return the current HTTP retry scheduling rules.",
    inputSchema: emptySchema,
    metadataInputSchema: emptyJsonSchema,
    handler: () => asResult("Retry policy", RETRY_POLICY),
  },
  {
    name: "list_recent_changes",
    title: "List Recent Policy Changes",
    description: "List recent policy updates.",
    inputSchema: emptySchema,
    metadataInputSchema: emptyJsonSchema,
    handler: () =>
      asResult("Recent policy changes", {
        changes: [
          { id: "POL-77", area: "discounts", summary: "Added premium threshold." },
          { id: "POL-81", area: "retries", summary: "Updated retry delays." },
        ],
      }),
  },
  ...[
    "audit_controls",
    "access_reviews",
    "architecture_records",
    "billing_terms",
    "compliance_matrix",
    "customer_segments",
    "data_retention",
    "deployment_policy",
    "engineering_ladder",
    "environment_matrix",
    "feature_flags",
    "finance_controls",
    "incident_metrics",
    "incident_playbook",
    "integration_registry",
    "legal_hold",
    "localization_rules",
    "observability_policy",
    "partner_handbook",
    "pricing_catalog",
    "procurement_rules",
    "privacy_review",
    "product_taxonomy",
    "release_guardrails",
    "risk_register",
    "security_baseline",
    "support_matrix",
    "training_catalog",
    "vendor_registry",
  ].map((name) => ({
    name,
    title: name.replaceAll("_", " "),
    description: `Read deterministic ${name.replaceAll("_", " ")} reference data.`,
    inputSchema: emptySchema,
    metadataInputSchema: emptyJsonSchema,
    handler: () => asResult(name, { id: name, status: "current", relevantToBenchmark: false }),
  })),
];

const ticketTools = [
  {
    name: "search",
    title: "Search Tickets",
    description: "Search issue tracker tickets.",
    inputSchema: querySchema,
    metadataInputSchema: queryJsonSchema,
    handler: ({ query = "" }) =>
      asResult("Ticket search results", {
        query,
        results: TICKETS.filter((ticket) =>
          matchText(`${ticket.id} ${ticket.title} ${ticket.summary}`, query),
        ),
      }),
  },
  {
    name: "get",
    title: "Get Ticket",
    description: "Fetch a single ticket by id.",
    inputSchema: idSchema,
    metadataInputSchema: idJsonSchema,
    handler: ({ id }) =>
      asResult(
        "Ticket record",
        TICKETS.find((ticket) => ticket.id === id) ?? { id, error: "ticket not found" },
      ),
  },
  {
    name: "get_ticket",
    title: "Get Ticket",
    description: "Fetch a ticket with tracker-specific metadata.",
    inputSchema: idSchema,
    metadataInputSchema: idJsonSchema,
    handler: ({ id }) =>
      asResult(
        "Ticket record",
        TICKETS.find((ticket) => ticket.id === id) ?? { id, error: "ticket not found" },
      ),
  },
  {
    name: "search_tickets",
    title: "Search Tickets",
    description: "Search tickets by title, id, or summary.",
    inputSchema: querySchema,
    metadataInputSchema: queryJsonSchema,
    handler: ({ query = "" }) =>
      asResult("Ticket search results", {
        query,
        results: TICKETS.filter((ticket) =>
          matchText(`${ticket.id} ${ticket.title} ${ticket.summary}`, query),
        ),
      }),
  },
  {
    name: "list_recent_changes",
    title: "List Recent Ticket Changes",
    description: "List recent ticket activity.",
    inputSchema: emptySchema,
    metadataInputSchema: emptyJsonSchema,
    handler: () =>
      asResult("Recent ticket changes", {
        changes: [
          { ticketId: "BENCH-101", event: "moved to ready" },
          { ticketId: "BENCH-102", event: "linked to retry policy" },
        ],
      }),
  },
  ...[
    "assign_owner",
    "create_ticket",
    "escalate_ticket",
    "list_blockers",
    "list_milestones",
    "list_risks",
    "list_watchers",
    "merge_calendar",
    "oncall_roster",
    "priority_matrix",
    "program_board",
    "qa_assignments",
    "release_notes",
    "roadmap_links",
    "runbook_links",
    "sprint_capacity",
    "status_rollup",
    "stakeholder_map",
    "support_queue",
    "team_directory",
    "test_plan",
    "timeline_forecast",
    "triage_queue",
    "backlog_health",
    "dependency_map",
    "handoff_notes",
    "incident_links",
    "launch_checklist",
    "owner_rotation",
    "velocity_report",
    "workload_balance",
  ].map((name) => ({
    name,
    title: name.replaceAll("_", " "),
    description: `Return deterministic ${name.replaceAll("_", " ")} ticket data.`,
    inputSchema: emptySchema,
    metadataInputSchema: emptyJsonSchema,
    handler: () => asResult(name, { id: name, count: 2, relevantToBenchmark: false }),
  })),
];

const apiTools = [
  {
    name: "search",
    title: "Search API Schemas",
    description: "Search internal API schema catalog.",
    inputSchema: querySchema,
    metadataInputSchema: queryJsonSchema,
    handler: ({ query = "" }) =>
      asResult("API schema search results", {
        query,
        results: API_SCHEMAS.filter((schema) =>
          matchText(
            `${schema.id} ${schema.method} ${schema.path} ${schema.fields.join(" ")}`,
            query,
          ),
        ),
      }),
  },
  {
    name: "get",
    title: "Get API Schema",
    description: "Fetch a schema from the API catalog by id.",
    inputSchema: idSchema,
    metadataInputSchema: idJsonSchema,
    handler: ({ id }) =>
      asResult(
        "API schema",
        API_SCHEMAS.find((schema) => schema.id === id) ?? { id, error: "schema not found" },
      ),
  },
  {
    name: "lookup_schema",
    title: "Lookup Schema",
    description: "Look up a deterministic API schema by id.",
    inputSchema: idSchema,
    metadataInputSchema: idJsonSchema,
    handler: ({ id }) =>
      asResult(
        "API schema",
        API_SCHEMAS.find((schema) => schema.id === id) ?? { id, error: "schema not found" },
      ),
  },
  {
    name: "api_schema_get",
    title: "API Schema Get",
    description: "Fetch API schema details with fields and endpoint path.",
    inputSchema: idSchema,
    metadataInputSchema: idJsonSchema,
    handler: ({ id }) =>
      asResult(
        "API schema",
        API_SCHEMAS.find((schema) => schema.id === id) ?? { id, error: "schema not found" },
      ),
  },
  {
    name: "list_recent_changes",
    title: "List Recent API Changes",
    description: "List recent API catalog changes.",
    inputSchema: emptySchema,
    metadataInputSchema: emptyJsonSchema,
    handler: () =>
      asResult("Recent API changes", {
        changes: [
          { schemaId: "retry-decision", summary: "Added retryable status code list." },
          { schemaId: "discount-request", summary: "Documented cart threshold field." },
        ],
      }),
  },
  ...[
    "auth_scopes",
    "access_tokens",
    "cache_contract",
    "client_examples",
    "compatibility_matrix",
    "deprecation_calendar",
    "endpoint_health",
    "error_codes",
    "example_payloads",
    "field_ownership",
    "gateway_routes",
    "idempotency_keys",
    "integration_tests",
    "latency_budget",
    "migration_guides",
    "pagination_rules",
    "payload_limits",
    "protocol_versions",
    "retry_headers",
    "rate_limits",
    "sdk_catalog",
    "schema_diff",
    "service_owners",
    "status_codes",
    "webhook_catalog",
    "webhook_examples",
    "traffic_replay",
    "version_policy",
  ].map((name) => ({
    name,
    title: name.replaceAll("_", " "),
    description: `Return deterministic ${name.replaceAll("_", " ")} API catalog data.`,
    inputSchema: emptySchema,
    metadataInputSchema: emptyJsonSchema,
    handler: () => asResult(name, { id: name, stable: true, relevantToBenchmark: false }),
  })),
];

export const TOOLSETS = {
  policy: policyTools,
  tickets: ticketTools,
  api: apiTools,
};

export const listToolMetadata = (serverName) => {
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

export function createMockMcpServer(serverName) {
  const validServerName = validateServerName(serverName);

  return {
    connect: () => startStdioMcpServer(validServerName),
  };
}

function startStdioMcpServer(serverName) {
  const tools = TOOLSETS[serverName];
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    buffer = processMcpBuffer(buffer, (message) => handleMcpMessage(serverName, tools, message));
  });
}

function processMcpBuffer(buffer, handleMessage) {
  let cursor = buffer;

  while (cursor.length > 0) {
    const headerEnd = cursor.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return cursor;
    }

    const header = cursor.subarray(0, headerEnd).toString("utf8");
    const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      throw new Error("Invalid MCP message: missing Content-Length header.");
    }

    const bodyStart = headerEnd + 4;
    const bodyLength = Number(lengthMatch[1]);
    const bodyEnd = bodyStart + bodyLength;
    if (cursor.length < bodyEnd) {
      return cursor;
    }

    const body = cursor.subarray(bodyStart, bodyEnd).toString("utf8");
    handleMessage(JSON.parse(body));
    cursor = cursor.subarray(bodyEnd);
  }

  return cursor;
}

function handleMcpMessage(serverName, tools, message) {
  if (message.id === undefined || String(message.method).startsWith("notifications/")) {
    return;
  }

  try {
    if (message.method === "initialize") {
      writeMcpMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: `benchmark-${serverName}`, version: "1.0.0" },
        },
      });
      return;
    }

    if (message.method === "tools/list") {
      writeMcpMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: listToolMetadata(serverName) },
      });
      return;
    }

    if (message.method === "tools/call") {
      const tool = tools.find(({ name }) => name === message.params?.name);
      if (!tool) {
        throw new Error(`Unknown tool ${message.params?.name}`);
      }
      writeMcpMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: tool.handler(message.params?.arguments ?? {}),
      });
      return;
    }

    throw new Error(`Unsupported MCP method ${message.method}`);
  } catch (error) {
    writeMcpMessage({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function writeMcpMessage(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function parseArgs(argv) {
  const serverFlagIndex = argv.indexOf("--server");
  const serverName = serverFlagIndex === -1 ? "policy" : argv[serverFlagIndex + 1];

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

  createMockMcpServer(validServerName).connect();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
