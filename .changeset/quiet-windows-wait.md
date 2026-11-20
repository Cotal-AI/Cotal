---
"@cotal-ai/cli": patch
---

Stop connector seeding after the current install when the seed command receives SIGTERM, and exit 143 so callers can tell it was cancelled.
