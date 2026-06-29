---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: MongoDB
description: Inspect MongoDB databases, collections, schemas, indexes, queries, and Atlas resources through MongoDB's MCP server with read-only access by default.
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

Use this Caplet when an agent needs MongoDB database, collection, schema, index, query, sample document, or Atlas operational context.

## First Workflow

1. Start by confirming the cluster, database, collection, Atlas project, environment, and read-only intent before querying data.
2. Inspect schema samples, indexes, query plans, and collection metadata before recommending query or index changes.
3. Keep result windows small and project only the fields needed to answer the question.
4. Summarize proposed writes, index changes, Atlas actions, or migration steps before removing `--readOnly` or changing credentials.

## Operate Carefully

- The catalog entry starts MongoDB MCP with `--readOnly` and a Vault-backed connection string by default.
- MongoDB data can contain production records, PII, secrets, and customer information. Avoid broad scans and redact sensitive fields in summaries.
- For Atlas API workflows, configure the upstream server with least-privilege Atlas service account credentials instead of a database connection string.
- Avoid this Caplet when the task only needs local ODM models, migrations, or application code.
