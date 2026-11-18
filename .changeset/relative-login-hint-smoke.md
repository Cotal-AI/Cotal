---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

The signed-out status smoke test now checks the correct login hint without requiring a global install. The CLI's executable check accepts a working directory so the test resolves relative PATH entries from the same directory as the command it runs.
