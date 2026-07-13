---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: MongoDB
description: Inspect MongoDB databases, collections, schemas, indexes, queries, and Atlas resources through MongoDB's MCP server with read-only access by default.
avoidWhen: Avoid when the work only concerns local ODM models, migrations, or application code rather than live MongoDB or Atlas state.
tags:
  - mongodb
  - atlas
  - database
  - queries
  - nosql
catalog:
  icon: https://www.mongodb.com/favicon.ico
setup:
  verify:
    - label: Check Node.js is available
      command: node
      args:
        - --version
    - label: Check npx is available
      command: npx
      args:
        - --version
mcpServer:
  command: npx
  args:
    - -y
    - mongodb-mcp-server@latest
    - --readOnly
  env:
    MDB_MCP_CONNECTION_STRING: $vault:MDB_MCP_CONNECTION_STRING
  startupTimeoutMs: 100000
  callTimeoutMs: 300000
---

# MongoDB

## Query Scope

Before querying data, establish the cluster, database, collection, Atlas project, environment, and read-only intent. Schema samples, indexes, query plans, and collection metadata provide context for proposed query or index changes. Small result windows and projections limited to necessary fields reduce exposure.

## Safe Operation

- The catalog entry starts MongoDB MCP with `--readOnly` and a Vault-backed connection string by default.
- Removing `--readOnly`, changing credentials, writing data, changing indexes, or performing Atlas actions requires review of the proposed target and effect.
- MongoDB data can contain production records, PII, secrets, and customer information. Broad scans should be avoided, and sensitive fields should be redacted from summaries.
- Atlas API access should use least-privilege Atlas service account credentials instead of a database connection string.
