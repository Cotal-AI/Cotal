---
"@cotal-ai/connector-hermes": patch
---

The Hermes bridge now forwards an inbox item's `historical` flag to the sidecar, and the adapter frames a join-time backfill with the same `(history) ` prefix connector-core's `fmtItem` gives the other connectors, so a retained @mention replayed after a gateway restart no longer reads as a live request.
