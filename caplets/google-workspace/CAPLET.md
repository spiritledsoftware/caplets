---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Workspace
description: Search, read, create, and update Gmail, Drive, Docs, Sheets, Slides, and Tasks through one Workspace capability suite.
tags:
  - google
  - workspace
  - productivity
  - email
  - files
catalog:
  icon: https://workspace.google.com/favicon.ico
googleDiscoveryApis:
  gmail:
    name: Gmail
    description: Search, read, label, draft, and send Gmail messages.
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
  drive:
    name: Google Drive
    description: Search, read, download, upload, and manage Drive files.
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
  docs:
    name: Google Docs
    description: Read, create, and edit Google Docs documents.
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
  sheets:
    name: Google Sheets
    description: Read, create, and update Google Sheets spreadsheets.
    discoveryUrl: https://sheets.googleapis.com/$discovery/rest?version=v4
    includeOperations:
      - sheets.spreadsheets.get
      - sheets.spreadsheets.getByDataFilter
      - sheets.spreadsheets.create
      - sheets.spreadsheets.batchUpdate
      - sheets.spreadsheets.developerMetadata.search
      - sheets.spreadsheets.values.get
      - sheets.spreadsheets.values.batchGet
      - sheets.spreadsheets.values.batchGetByDataFilter
      - sheets.spreadsheets.values.update
      - sheets.spreadsheets.values.batchUpdate
      - sheets.spreadsheets.values.append
      - sheets.spreadsheets.values.clear
    auth:
      type: oauth2
      issuer: https://accounts.google.com
      clientId: $vault:GOOGLE_CLIENT_ID
      clientSecret: $vault:GOOGLE_CLIENT_SECRET
      scopes:
        - https://www.googleapis.com/auth/drive.file
  slides:
    name: Google Slides
    description: Read, create, preview, and edit Google Slides presentations.
    discoveryUrl: https://slides.googleapis.com/$discovery/rest?version=v1
    includeOperations:
      - slides.presentations.get
      - slides.presentations.pages.get
      - slides.presentations.pages.getThumbnail
      - slides.presentations.create
      - slides.presentations.batchUpdate
    auth:
      type: oauth2
      issuer: https://accounts.google.com
      clientId: $vault:GOOGLE_CLIENT_ID
      clientSecret: $vault:GOOGLE_CLIENT_SECRET
      scopes:
        - https://www.googleapis.com/auth/drive.file
  tasks:
    name: Google Tasks
    description: Read, create, update, organize, and complete Google Tasks.
    discoveryUrl: https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest
    includeOperations:
      - tasks.tasklists.list
      - tasks.tasklists.get
      - tasks.tasklists.insert
      - tasks.tasklists.patch
      - tasks.tasklists.update
      - tasks.tasks.list
      - tasks.tasks.get
      - tasks.tasks.insert
      - tasks.tasks.patch
      - tasks.tasks.update
      - tasks.tasks.move
    auth:
      type: oauth2
      issuer: https://accounts.google.com
      clientId: $vault:GOOGLE_CLIENT_ID
      clientSecret: $vault:GOOGLE_CLIENT_SECRET
      scopes:
        - https://www.googleapis.com/auth/tasks
---

# Google Workspace

## Suite operation

Identify which Workspace surface owns the source of truth: mail, file metadata, document content, spreadsheet data, deck content, or task state. Search or inspect metadata before reading large content bodies.

The suite exposes separate child handles: `google-workspace__gmail`, `google-workspace__drive`, `google-workspace__docs`, `google-workspace__sheets`, `google-workspace__slides`, and `google-workspace__tasks`. These names are operator reference; the frontmatter backend map remains the runtime authority.

Before changing live state, inspect the current resource and confirm the relevant file or document ID, spreadsheet range, slide or page element ID, message or thread ID, label, recipient, tasklist, or task ID.

## Safety and access boundaries

- Workspace data can contain private customer, employee, legal, financial, or regulated information. Keep reads narrow and summaries minimal.
- Child OAuth scopes are intentionally separate so a private fork can remove surfaces or narrow scopes without changing the suite shape.
- Drive, Sheets, and Slides use the restricted `drive.file` scope. They cover files the app created and files the user explicitly opens or grants to the app.
- Gmail operations can label, draft, modify, or send messages. Confirm recipients and content before sending.
- Docs, Sheets, and Slides batch updates change live files. Inspect current structure and plan changes before updating.
- Tasks are user-visible workflow state. Do not infer deadlines or completion from ambiguous conversation.
