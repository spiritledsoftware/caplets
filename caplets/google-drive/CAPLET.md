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

## File discovery

Search accessible metadata first by name, owner, MIME type, folder, modified time, or shared-drive context. Confirm the exact file ID before reading, downloading, updating, moving, trashing, or deleting. Read or download only the files needed for the operator's task, and consider creating a new file or draft copy before overwriting an existing shared document.

## Access boundary and limits

- Drive files can contain private, shared, or regulated information. Keep reads narrow and summaries limited to what is needed.
- The restricted `drive.file` OAuth scope covers files the app created and files the user explicitly opens or grants to the app; it does not provide unrestricted Drive-wide access.
- This Caplet does not expose Drive-wide sharing, permissions, comments, approvals, shared-drive administration, or trash-emptying operations. Those operations require a private variant.
