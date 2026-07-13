---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Slides
description: Read, create, preview, and edit Google Slides presentations through the Slides API Discovery document.
avoidWhen: Use Google Drive for finding, sharing, copying, moving, trashing, or deleting presentation files.
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

## Presentation prerequisites

Start with a presentation ID, presentation URL, or newly created presentation. Use `presentations.get` to inspect slide order, page element IDs, layouts, and existing text. Page reads and thumbnails can provide visual confirmation of a specific slide.

## Safe updates and access

- Presentations can contain private plans, customer material, or financial data. Inspect only the slides needed for the operator's task.
- `presentations.batchUpdate` changes live deck content and formatting. Confirm page and element IDs, then group text, image, layout, and styling changes into a deliberate batch.
- The restricted `drive.file` OAuth scope covers Slides files the app created and files the user explicitly opens or grants to the app.
