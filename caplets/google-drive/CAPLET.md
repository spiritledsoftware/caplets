---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Drive
description: Search, read, download, upload, and manage Google Drive files through the Drive API Discovery document.
tags:
  - google
  - drive
  - files
googleDiscoveryApi:
  discoveryUrl: https://www.googleapis.com/discovery/v1/apis/drive/v3/rest
  auth:
    type: oauth2
    issuer: https://accounts.google.com
    clientId: $vault:GOOGLE_CLIENT_ID
    clientSecret: $vault:GOOGLE_CLIENT_SECRET
    scopes:
      - https://www.googleapis.com/auth/drive.file
      - https://www.googleapis.com/auth/drive.metadata.readonly
---

# Google Drive

Use this Caplet when an agent needs Drive files as context or needs to create/update files with explicit user direction.

## Scope Guidance

Prefer `drive.file` and `drive.metadata.readonly` for public-safe use. Google recommends narrow scopes where possible; broad Drive scopes such as `drive` and `drive.readonly` are restricted and should be added only in a reviewed private Caplet.

## Use Carefully

Search metadata before reading content. Confirm file IDs and names before upload, update, trash, or delete operations, especially on shared drives.
