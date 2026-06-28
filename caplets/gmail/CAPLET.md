---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Gmail
description: Search, read, label, draft, and send Gmail messages through the Gmail API Discovery document.
tags:
  - google
  - gmail
  - email
catalog:
  icon: https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png
googleDiscoveryApi:
  discoveryUrl: https://gmail.googleapis.com/$discovery/rest?version=v1
  includeOperations:
    - gmail.users.getProfile
    - gmail.users.labels.list
    - gmail.users.labels.get
    - gmail.users.labels.create
    - gmail.users.labels.patch
    - gmail.users.labels.update
    - gmail.users.messages.list
    - gmail.users.messages.get
    - gmail.users.messages.attachments.get
    - gmail.users.messages.modify
    - gmail.users.messages.send
    - gmail.users.threads.list
    - gmail.users.threads.get
    - gmail.users.threads.modify
    - gmail.users.drafts.list
    - gmail.users.drafts.get
    - gmail.users.drafts.create
    - gmail.users.drafts.update
    - gmail.users.drafts.send
  auth:
    type: oauth2
    issuer: https://accounts.google.com
    clientId: $vault:GOOGLE_CLIENT_ID
    clientSecret: $vault:GOOGLE_CLIENT_SECRET
    scopes:
      - https://www.googleapis.com/auth/gmail.modify
---

# Gmail

Use this Caplet when an agent needs Gmail context for support, scheduling, customer communication, or inbox triage.

## First Workflow

1. Start with narrow searches by sender, subject, label, date range, or thread when possible.
2. Read message metadata and thread context before retrieving full message bodies.
3. Summarize only the details needed for the user's task.
4. Draft replies before sending, and ask for explicit user intent before modifying labels or sending.

## Operate Carefully

- Email often contains private or regulated content. Keep queries narrow and summaries minimal.
- Confirm recipients, thread IDs, labels, and draft contents before any write operation.
- This Caplet does not expose Gmail settings, permanent deletion, trash/untrash, import/insert, watch, or forwarding operations; create a private variant if those are required.
- Prefer a task or calendar integration when the work is only follow-up tracking and does not require email content.
