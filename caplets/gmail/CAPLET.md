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

## Reading mail

Use narrow searches by sender, subject, label, date range, or thread. Inspect message metadata and thread context before retrieving full bodies, and limit summaries to the information the operator needs.

## Safe operation and limits

- Email can contain private or regulated content. Keep queries narrow and summaries minimal.
- Before modifying labels or sending mail, confirm explicit operator intent, recipients, thread IDs, labels, and draft contents. Draft replies before sending.
- This Caplet does not expose Gmail settings, permanent deletion, trash/untrash, import/insert, watch, or forwarding operations. Those operations require a private variant.
