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
---

# Gmail

Use this Caplet when an agent needs Gmail context for support, scheduling, customer communication, or inbox triage.

## Use Carefully

Email often contains private or regulated content. Keep queries narrow, summarize minimally, and require explicit user intent before sending, modifying, trashing, or deleting messages.
