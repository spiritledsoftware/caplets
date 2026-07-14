---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Tasks
description: Read, create, update, organize, and complete Google Tasks through the Google Tasks API Discovery document.
tags:
  - google
  - tasks
  - productivity
catalog:
  icon: https://www.gstatic.com/images/branding/product/2x/tasks_48dp.png
googleDiscoveryApi:
  discoveryUrl: https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest
  includeOperations:
    - tasks.tasklists.list
    - tasks.tasklists.get
    - tasks.tasklists.insert
    - tasks.tasklists.patch
    - tasks.tasklists.update
    - tasks.tasks.list
    - tasks.tasks.get
    - tasks.tasks.insert
    - tasks.tasks.patch
    - tasks.tasks.update
    - tasks.tasks.move
  auth:
    type: oauth2
    issuer: https://accounts.google.com
    clientId: $vault:GOOGLE_CLIENT_ID
    clientSecret: $vault:GOOGLE_CLIENT_SECRET
    scopes:
      - https://www.googleapis.com/auth/tasks
---

# Google Tasks

## Task and tasklist handling

List tasklists before choosing a destination. Search existing tasks before creating one to avoid duplicates. Before creating or moving a task, confirm its title, notes, due date, parent task, and tasklist.

## Safe operation and limits

- Task changes are user-visible workflow state. Read current state first and keep writes specific.
- Do not infer deadlines or completion from ambiguous conversation. Mark a task complete only after the operator or the current workflow clearly confirms completion.
- This Caplet does not expose task deletion, tasklist deletion, or clear-completed operations. Those operations require a private variant.
