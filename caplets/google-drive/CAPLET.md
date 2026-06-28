---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Drive
description: Search, read, download, upload, and manage Google Drive files through the Drive API Discovery document.
tags:
  - google
  - drive
  - files
catalog:
  icon: https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png
googleDiscoveryApi:
  discoveryUrl: https://www.googleapis.com/discovery/v1/apis/drive/v3/rest
  includeOperations:
    - drive.files.list
    - drive.files.get
    - drive.files.export
    - drive.files.download
    - drive.files.create
    - drive.files.update
    - drive.files.copy
    - drive.files.delete
    - drive.files.generateIds
  auth:
    type: oauth2
    issuer: https://accounts.google.com
    clientId: $vault:GOOGLE_CLIENT_ID
    clientSecret: $vault:GOOGLE_CLIENT_SECRET
    scopes:
      - https://www.googleapis.com/auth/drive.file
---

# Google Drive

Use this Caplet when an agent needs Drive files as context or needs to create/update files with explicit user direction.

## First Workflow

1. Search accessible file metadata first by name, owner, MIME type, folder, modified time, or shared-drive context.
2. Confirm the exact file ID before reading, downloading, updating, moving, trashing, or deleting.
3. Read or download only the files needed for the task.
4. Prefer creating a new file or draft copy before overwriting an existing shared document.

## Operate Carefully

- Drive files may contain private, shared, or regulated information. Keep reads narrow and summarize only what is needed.
- This Caplet uses the restricted `drive.file` scope, so it is intended for files the app created or files the user explicitly opens or grants to the app.
- It does not expose Drive-wide sharing, permissions, comments, approvals, shared-drive administration, or trash-emptying operations; create a private variant if those are required.
- Prefer repository files when the user is asking about local project state.
