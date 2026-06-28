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

Use this Caplet when an agent needs Google Chat context, space membership context, message history, or a deliberate outgoing Chat message.

## First Workflow

1. Start by finding the relevant space, direct message, or group chat.
2. Read recent message history and membership context before summarizing or drafting a reply.
3. Download media only when the attachment is necessary for the user's task.
4. Send messages or add reactions only when the target space, thread, recipients, and message content are explicit.

## Operate Carefully

- Chat messages can contain sensitive internal discussion. Keep reads narrow and summarize only what the user needs.
- Outgoing Chat messages are visible to real people. Draft first when intent or audience is ambiguous.
- This Caplet does not expose message update/delete, space administration, custom emoji, availability, import, or organization-wide admin operations.
- Prefer Gmail or a task system when the work is email-centric or durable task tracking rather than Chat collaboration.
