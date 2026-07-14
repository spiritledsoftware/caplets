---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Docs
description: Read, create, and edit Google Docs documents through the Google Docs API Discovery document.
tags:
  - google
  - docs
  - documents
  - productivity
catalog:
  icon: https://www.gstatic.com/images/branding/product/2x/docs_2020q4_48dp.png
googleDiscoveryApi:
  discoveryUrl: https://docs.googleapis.com/$discovery/rest?version=v1
  includeOperations:
    - docs.documents.get
    - docs.documents.create
    - docs.documents.batchUpdate
  auth:
    type: oauth2
    issuer: https://accounts.google.com
    clientId: $vault:GOOGLE_CLIENT_ID
    clientSecret: $vault:GOOGLE_CLIENT_SECRET
    scopes:
      - https://www.googleapis.com/auth/documents
---

# Google Docs

## Document prerequisites

Start with a document ID, document URL, or the newly created document returned by `documents.create`. Inspect current structure with `documents.get` before planning content or formatting changes. Confirm the target document ID and intended changes before creating or updating a document.

## Safe updates

- Google Docs content can contain private, shared, or regulated information. Read only the sections needed for the operator's task.
- `documents.batchUpdate` changes live content and formatting. Group a deliberate set of content and formatting requests into one batch where practical rather than making exploratory writes.
