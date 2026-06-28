---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Sheets
description: Read, create, and update Google Sheets spreadsheets through the Sheets API Discovery document.
tags:
  - google
  - sheets
  - spreadsheets
  - data
catalog:
  icon: https://www.gstatic.com/images/branding/product/2x/sheets_2020q4_48dp.png
googleDiscoveryApi:
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
---

# Google Sheets

Use this Caplet when an agent needs to inspect spreadsheet structure, read bounded ranges, append tabular data, or make explicit updates to a known Google Sheet.

## First Workflow

1. Start from a spreadsheet ID, spreadsheet URL, or newly created spreadsheet.
2. Inspect sheet names, grid properties, named ranges, and developer metadata before reading large ranges.
3. Read only the ranges needed for the task, using `values.get`, `values.batchGet`, or data filters.
4. Confirm target sheet, range, value shape, and whether formulas should be preserved before updating, appending, or clearing cells.

## Operate Carefully

- Spreadsheets often contain private business data. Prefer narrow ranges and summaries over full-sheet reads.
- `batchUpdate`, value updates, appends, and clears change live spreadsheet state. Treat clearing cells as destructive.
- This Caplet uses the restricted `drive.file` scope, so it is intended for Sheets the app created or files the user explicitly opens or grants to the app.
- Use Google Drive for locating, sharing, copying, moving, trashing, or deleting spreadsheet files.
