---
confidence: 0.95
sources: [architecture/_index.md, facts/_index.md]
synthesized_at: '2026-05-21T23:23:26.215Z'
type: synthesis
title: Remote auth correctness depends on callback-complete success and bounded flow cleanup
summary: Remote login should only succeed after OAuth callback completion, and pending auth flows need bounded lifecycle cleanup.
tags: [auth, remote-control, oauth, lifecycle]
related: []
keywords: [oauth, callback, success, pending, flow, cleanup, map, abandoned]
createdAt: '2026-05-21T23:23:26.215Z'
updatedAt: '2026-05-21T23:23:26.215Z'
---

# Remote auth correctness depends on callback-complete success and bounded flow cleanup

Architecture and facts both point to the same remote-auth risk profile: login success must be reported only after the OAuth callback completes, and pending auth flows need cleanup so abandoned flows do not remain in memory indefinitely. The review findings turn the ownership model into an implementation constraint with concrete failure modes and verification status.

## Evidence

- **architecture**: Remote auth review findings identify a high-severity issue where login reports success too early, immediately after `auth_login_start`, before OAuth callback completion, and a medium-severity issue where pending auth flows are stored in an unbounded Map and are only removed after `flow.complete(callbackUrl)` succeeds.
- **facts**: The curated project knowledge captures review outcomes and regression patterns for remote control, emphasizing server-side state handling, redacted errors, and verification-backed approvals after fixes.
