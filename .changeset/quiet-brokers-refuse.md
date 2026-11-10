---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Commands now reject invalid broker URLs and honor TLS schemes in `--server`.
Per-command connections share registration's URL validation, preserve WebSocket routes,
and require TLS for secure schemes on registered and raw connections.
