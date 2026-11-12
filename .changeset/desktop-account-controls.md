---
"cotal-ai": patch
"@cotal-ai/auth": patch
---

Add confirmed sign-out and disconnect controls to desktop Settings.

Sign-out shares the CLI's provider-session revocation and local sign-in cleanup while leaving existing computer connections running. Disconnect uses the existing per-space operations and reports incomplete outcomes without claiming credential erasure or remote revocation.
