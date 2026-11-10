---
"@cotal-ai/connector-opencode": patch
---

Let fresh OpenCode launches finish their first-run preparation and keep failed boot logs for diagnosis.

The launcher now waits the full two-minute cold-start window, keeps probing until the session is ready, and retains private per-launch server output after exit. Startup failures say what was still pending and how to retry without truncating the diagnostic around a database path.
