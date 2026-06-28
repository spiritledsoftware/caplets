---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Meet
description: Create Meet spaces and inspect Meet conference records, participants, recordings, transcripts, and smart notes through the Meet API Discovery document.
tags:
  - google
  - meet
  - meetings
  - video
catalog:
  icon: https://www.gstatic.com/images/branding/product/2x/meet_2020q4_48dp.png
googleDiscoveryApi:
  discoveryUrl: https://meet.googleapis.com/$discovery/rest?version=v2
  includeOperations:
    - meet.spaces.create
    - meet.spaces.get
    - meet.spaces.patch
    - meet.spaces.endActiveConference
    - meet.conferenceRecords.list
    - meet.conferenceRecords.get
    - meet.conferenceRecords.participants.list
    - meet.conferenceRecords.participants.get
    - meet.conferenceRecords.recordings.list
    - meet.conferenceRecords.recordings.get
    - meet.conferenceRecords.transcripts.list
    - meet.conferenceRecords.transcripts.get
    - meet.conferenceRecords.transcripts.entries.list
    - meet.conferenceRecords.transcripts.entries.get
    - meet.conferenceRecords.smartNotes.list
    - meet.conferenceRecords.smartNotes.get
  auth:
    type: oauth2
    issuer: https://accounts.google.com
    clientId: $vault:GOOGLE_CLIENT_ID
    clientSecret: $vault:GOOGLE_CLIENT_SECRET
    scopes:
      - https://www.googleapis.com/auth/meetings.space.created
      - https://www.googleapis.com/auth/meetings.space.readonly
---

# Google Meet

Use this Caplet when an agent needs to create an app-managed Meet space or inspect meeting records, participants, recordings, transcripts, or smart notes.

## First Workflow

1. Start from a Meet space, conference record, meeting code, or newly created space.
2. Inspect the conference record and participant list before reading recordings, transcripts, or smart notes.
3. Read transcript entries or smart notes only for the time range and topic needed by the user.
4. Patch or end an active conference only for app-created spaces and only when the user intent is explicit.

## Operate Carefully

- Meeting records, transcripts, recordings, and smart notes can contain sensitive personal and business information. Keep reads narrow.
- Creating, patching, or ending Meet spaces changes live collaboration state. Confirm meeting ownership and timing before mutating.
- This Caplet avoids organization-wide Meet settings and only exposes app-created space management plus read-only meeting record inspection.
- Prefer Calendar when the user needs scheduling, invites, guest lists, or event lifecycle management.
