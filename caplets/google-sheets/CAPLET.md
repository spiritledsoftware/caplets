---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Sheets
description: Read, create, and update Google Sheets spreadsheets through the Sheets API Discovery document.
avoidWhen: Use Google Drive for locating, sharing, copying, moving, trashing, or deleting spreadsheet files.
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

## Spreadsheet prerequisites

Start with a spreadsheet ID, spreadsheet URL, or newly created spreadsheet. Inspect sheet names, grid properties, named ranges, and developer metadata before reading large ranges. Retrieve only needed ranges with `values.get`, `values.batchGet`, or data filters.

## Safe updates and access

- Confirm the target sheet, range, value shape, and whether formulas must be preserved before updating, appending, or clearing cells.
- Spreadsheets often contain private business data. Prefer bounded ranges and summaries over full-sheet reads.
- `batchUpdate`, value updates, appends, and clears change live spreadsheet state. Clearing cells is destructive.
- The restricted `drive.file` OAuth scope covers Sheets the app created and files the user explicitly opens or grants to the app.
