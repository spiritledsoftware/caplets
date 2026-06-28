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

Use this Caplet when an agent needs to inspect or manage Google Tasks during planning, follow-up, or personal workflow coordination.

## First Workflow

1. List tasklists before choosing where work belongs.
2. Search or list existing tasks before creating new ones to avoid duplicates.
3. Confirm task title, notes, due date, parent task, and tasklist before creating or moving.
4. Mark tasks complete only when the user or current workflow clearly confirms completion.

## Operate Carefully

- Task changes are user-visible workflow state. Read first and keep writes specific.
- Do not infer deadlines or completion state from vague conversation.
- This Caplet does not expose task deletion, tasklist deletion, or clear-completed operations; create a private variant if deletion workflows are required.
- Prefer Linear or GitHub Issues for team-owned engineering work.
