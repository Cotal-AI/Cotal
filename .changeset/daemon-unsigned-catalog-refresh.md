---
"cotal-ai": patch
---

Report when space catalogs cannot be refreshed because the daemon has no signed-in provider. The CLI returns AUTH_REQUIRED with a sign-in step while retaining saved spaces, and the desktop prompts for sign-in instead of treating the refresh as complete.
