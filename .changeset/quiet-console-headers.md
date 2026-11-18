---
"@cotal-ai/web": patch
"@cotal-ai/manager": patch
---

The dashboard and manager console restrict browser scripts to their own assets and omit referrers.

Both surfaces send Content-Security-Policy and X-Content-Type-Options headers. Dashboard launch links retain their single-use exchange. The manager console removes its launch token from the address bar after its page scripts load.
