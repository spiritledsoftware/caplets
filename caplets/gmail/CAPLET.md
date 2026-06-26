---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Gmail
description: Search, read, label, draft, and send Gmail messages through the Gmail API Discovery document.
tags:
  - google
  - gmail
  - email
googleDiscoveryApi:
  discoveryUrl: https://gmail.googleapis.com/$discovery/rest?version=v1
  auth:
    type: oauth2
    issuer: https://accounts.google.com
    clientId: $vault:GOOGLE_CLIENT_ID
    clientSecret: $vault:GOOGLE_CLIENT_SECRET
    scopes:
      - https://www.googleapis.com/auth/gmail.metadata
      - https://www.googleapis.com/auth/gmail.readonly
      - https://www.googleapis.com/auth/gmail.modify
---

# Gmail

Use this Caplet when an agent needs Gmail context for support, scheduling, customer communication, or inbox triage.

## Scope Guidance

Start with metadata or readonly access when possible. Add `gmail.modify` only when the workflow needs labels, archive, trash, drafts, or sending. Avoid the broad `https://mail.google.com/` scope unless a separate reviewed local Caplet genuinely needs permanent delete access.

## Use Carefully

Email often contains private or regulated content. Keep queries narrow, summarize minimally, and require explicit user intent before sending, modifying, trashing, or deleting messages.
