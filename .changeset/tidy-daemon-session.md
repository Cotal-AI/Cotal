---
"cotal-ai": patch
---

Daemon setup now asks for a new sign-in when the provider rejects a cached session. Connection checks validate the session through the existing bounded token cache, and provider outages stop setup without starting another device sign-in.
