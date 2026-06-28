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

Use this Caplet when an agent needs to inspect a form, create or revise form questions, or summarize submitted responses from a known Google Form.

## First Workflow

1. Start from a form ID, form URL, or newly created form.
2. Read the form structure before changing titles, descriptions, questions, grading, or navigation.
3. List responses only when response data is required, and narrow analysis to the fields relevant to the task.
4. Confirm question IDs, item locations, and response-safety expectations before using `forms.batchUpdate`.

## Operate Carefully

- Forms and responses may contain private, educational, health, or customer information. Keep response reads and summaries minimal.
- `forms.batchUpdate` can alter live collection instruments. Avoid casual edits to published forms.
- This Caplet uses the restricted `drive.file` scope, so it is intended for Forms the app created or files the user explicitly opens or grants to the app.
- It does not expose publish settings, watches, or deletion workflows; create a private variant if those are required.
