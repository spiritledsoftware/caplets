---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Google Chat
description: Search spaces, read messages, send messages, and add reactions through the Google Chat API Discovery document.
tags:
  - google
  - chat
  - messaging
  - collaboration
catalog:
  icon: https://www.gstatic.com/images/branding/product/2x/chat_2020q4_48dp.png
googleDiscoveryApi:
  discoveryUrl: https://chat.googleapis.com/$discovery/rest?version=v1
  includeOperations:
    - chat.spaces.list
    - chat.spaces.search
    - chat.spaces.get
    - chat.spaces.findDirectMessage
    - chat.spaces.findGroupChats
    - chat.spaces.members.list
    - chat.spaces.members.get
    - chat.spaces.messages.list
    - chat.spaces.messages.get
    - chat.media.download
    - chat.spaces.messages.create
    - chat.spaces.messages.reactions.create
  auth:
    type: oauth2
    issuer: https://accounts.google.com
    clientId: $vault:GOOGLE_CLIENT_ID
    clientSecret: $vault:GOOGLE_CLIENT_SECRET
    scopes:
      - https://www.googleapis.com/auth/chat.spaces.readonly
      - https://www.googleapis.com/auth/chat.memberships.readonly
      - https://www.googleapis.com/auth/chat.messages.readonly
      - https://www.googleapis.com/auth/chat.messages.create
      - https://www.googleapis.com/auth/chat.messages.reactions.create
---

# Google Chat

## Finding conversation context

Locate the relevant space, direct message, or group chat first. Read recent history and membership context before preparing a summary or reply. Download media only when the attachment is necessary for the operator's task.

## Safe operation and limits

- Chat messages can contain sensitive internal discussion. Keep reads narrow and summaries limited to what the operator needs.
- Outgoing messages and reactions are visible to real people. Confirm the target space, thread, recipients, and content; prepare a draft first when intent or audience is ambiguous.
- This Caplet does not expose message update/delete, space administration, custom emoji, availability, import, or organization-wide admin operations.
