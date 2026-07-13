---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Meet
description: Create Meet spaces and inspect Meet conference records, participants, recordings, transcripts, and smart notes through the Meet API Discovery document.
avoidWhen: Use Google Calendar for scheduling, invites, guest lists, or event lifecycle management.
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

## Meeting prerequisites

Start with a Meet space, conference record, meeting code, or newly created space. Inspect the conference record and participant list before accessing recordings, transcripts, or smart notes. Limit transcript entries and smart notes to the time range and topic the operator needs.

## Safe operation and limits

- Meeting records, transcripts, recordings, and smart notes can contain sensitive personal and business information. Keep reads narrow.
- Creating, patching, or ending Meet spaces changes live collaboration state. Confirm meeting ownership, timing, and operator intent before a mutation.
- Space mutations are limited to app-created spaces. The exposed meeting-record operations are read-only, and organization-wide Meet settings are not available.
