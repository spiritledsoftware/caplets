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

Use this Caplet when an agent needs to inspect document structure, create a new Google Doc, or apply explicit content and formatting updates to a known document.

## First Workflow

1. Start from a document ID, document URL, or newly created document returned by `documents.create`.
2. Use `documents.get` to inspect the current document structure before proposing edits.
3. Group content and formatting changes into one `documents.batchUpdate` request when possible.
4. Confirm the target document ID and intended changes before creating or updating documents.

## Operate Carefully

- Google Docs content can contain private, shared, or regulated information. Read only the document sections needed for the task.
- `documents.batchUpdate` can change real document content and formatting. Prefer a planned set of requests over exploratory writes.
- Use Google Drive for file search, folder placement, sharing, copying, moving, trashing, or deleting documents.
