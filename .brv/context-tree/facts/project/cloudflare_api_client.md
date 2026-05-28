---
title: Cloudflare API client
summary: Facts about Cloudflare API client
tags: []
related: []
keywords: []
createdAt: '2026-05-28T10:53:51.575Z'
updatedAt: '2026-05-28T10:53:51.575Z'
---
## Reason
Curated facts extracted from source context

## Raw Concept
**Task:**
Document facts about Cloudflare API client

**Timestamp:** 2026-05-28T10:53:51.569Z

**Author:** ByteRover Context Engineer

## Facts
- **Cloudflare API client**: Under Node 26, Alchemy’s Cloudflare API client receives gzipped bytes with no response headers (contentType: null, contentEncoding: null)
- **Cloudflare API client**: Under Node 24.15.0, the same Cloudflare endpoint returns correctly decoded JSON with contentType "application/json; charset=UTF-8" and contentEncoding "gzip"
