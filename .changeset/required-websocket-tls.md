---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

Refuse plaintext ws:// targets when TLS is required, both during mesh registration and when dialing existing records. Use wss:// for TLS-protected WebSocket connections. Keep ordinary plaintext loopback connections and WSS certificate and hostname verification unchanged.
