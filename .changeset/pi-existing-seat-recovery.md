---
"@cotal-ai/pi": patch
---

Let already-running managed Pi seats adopt crash recovery after an extension reload. Seats launched before the session-state environment variable existed derive the same lifecycle-keyed state path from their manager-owned persona file and lifecycle UID, then record the active Pi session atomically. Fresh managed seats also receive a Pi-native exact session ID before their first turn, so an idle seat is recoverable.
