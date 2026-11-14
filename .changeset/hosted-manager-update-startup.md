---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Keep the machine service responsive during manual updates.

Daemon startup checks the updater's full closure identity before taking restoration ownership, so it can answer readiness without waiting on the updater's installation lock. If that updater ends without finishing, the running daemon performs the existing guarded recovery or reports why recovery remains paused.
