---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Tasks
description: Read, create, update, organize, and complete Google Tasks through the Google Tasks API Discovery document.
tags:
  - google
  - tasks
  - productivity
googleDiscoveryApi:
  discoveryUrl: https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest
  auth:
    type: oauth2
    issuer: https://accounts.google.com
    clientId: $vault:GOOGLE_CLIENT_ID
    clientSecret: $vault:GOOGLE_CLIENT_SECRET
---

# Google Tasks

Use this Caplet when an agent needs to inspect or manage Google Tasks during planning, follow-up, or personal workflow coordination.

## Use Carefully

List existing tasklists and tasks before mutating. Confirm task names, due dates, and tasklist IDs before creating, completing, moving, or deleting tasks.
