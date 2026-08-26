---
---

Test-only: an end-to-end regression cell for the connector's boot lost-wake window — a peer message
that buffers before the `claude/channel` handshake activates must still wake the session with no
human turn. It drives the shipped wake policy against a real broker in `mcp.ts`'s own order and pins
both halves of the property: activation itself performs no reconcile, and the durable redelivery
re-announce is what recovers the dropped wake. A mutation config grades the cell against removal of
the re-announce. All the changed files are smoke/test wiring, so no shipped behaviour changes and no
release.
