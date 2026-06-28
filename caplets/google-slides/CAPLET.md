---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Slides
description: Read, create, preview, and edit Google Slides presentations through the Slides API Discovery document.
tags:
  - google
  - slides
  - presentations
  - productivity
catalog:
  icon: https://www.gstatic.com/images/branding/product/2x/slides_2020q4_48dp.png
googleDiscoveryApi:
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
---

# Google Slides

Use this Caplet when an agent needs to inspect a deck, create a presentation, preview slides, or apply explicit layout and content changes to a known Google Slides file.

## First Workflow

1. Start from a presentation ID, presentation URL, or newly created presentation.
2. Use `presentations.get` to inspect slide order, page element IDs, layouts, and existing text before planning edits.
3. Use page reads or thumbnails when the user needs visual confirmation of a specific slide.
4. Group text, image, layout, and styling changes into a deliberate `presentations.batchUpdate` request.

## Operate Carefully

- Presentations can contain private plans, customer material, or financial data. Inspect only the slides needed for the task.
- `presentations.batchUpdate` changes live deck content and formatting. Confirm page IDs and element IDs before mutating.
- This Caplet uses the restricted `drive.file` scope, so it is intended for Slides files the app created or files the user explicitly opens or grants to the app.
- Use Google Drive for finding, sharing, copying, moving, trashing, or deleting presentation files.
