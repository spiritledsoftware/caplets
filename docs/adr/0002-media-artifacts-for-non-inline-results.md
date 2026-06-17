# ADR 0002: Use Media Artifacts For Non-Inline Results

## Status

Accepted

## Context

Caplets backends can return binary media, downloads, exports, and textual responses too large to fit comfortably in structured tool output. Inline base64 is hard for coding agents to inspect, expensive in tokens, fragile when truncated, and unsuitable as a common contract across local, remote, and hosted execution.

## Decision

Caplets will represent binary media and oversized response content as Media artifacts by default. Local execution may return absolute paths under Caplets-managed artifact storage, while remote and hosted execution must return artifact references or links rather than fake local paths. Small JSON and text responses remain inline.

## Consequences

- Media-capable backends share one result contract instead of inventing backend-specific blob behavior.
- Agents should prefer file paths or artifact references for media input and output.
- Data URLs are allowed only as small-input fallback values and must not be echoed in logs, errors, or result previews.
- Backends that currently read all HTTP responses as bounded text need to route binary and oversized responses through shared artifact writing.
