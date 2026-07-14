---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Forms
description: Read, create, edit, and inspect responses for Google Forms through the Forms API Discovery document.
tags:
  - google
  - forms
  - surveys
  - responses
catalog:
  icon: https://www.gstatic.com/images/branding/product/2x/forms_2020q4_48dp.png
googleDiscoveryApi:
  discoveryUrl: https://forms.googleapis.com/$discovery/rest?version=v1
  includeOperations:
    - forms.forms.get
    - forms.forms.create
    - forms.forms.batchUpdate
    - forms.forms.responses.list
    - forms.forms.responses.get
  auth:
    type: oauth2
    issuer: https://accounts.google.com
    clientId: $vault:GOOGLE_CLIENT_ID
    clientSecret: $vault:GOOGLE_CLIENT_SECRET
    scopes:
      - https://www.googleapis.com/auth/drive.file
---

# Google Forms

## Form prerequisites

Start with a form ID, form URL, or a newly created form. Read the form structure before changing titles, descriptions, questions, grading, or navigation. For response analysis, retrieve only the required responses and fields.

## Safe updates and limits

- Confirm question IDs, item locations, and response-safety expectations before using `forms.batchUpdate`.
- Forms and responses can contain private educational, health, or customer information. Keep response reads and summaries minimal.
- `forms.batchUpdate` can alter a live collection instrument; published forms should only receive deliberate, reviewed changes.
- The restricted `drive.file` OAuth scope covers Forms the app created and files the user explicitly opens or grants to the app.
- This Caplet does not expose publish settings, watches, or deletion workflows. Those operations require a private variant.
