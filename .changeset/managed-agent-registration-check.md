---
"@cotal-ai/auth": patch
---

The managed-agent host doors (enrollment, prepare-retirement, and runtime create and status) now run one current-registration check instead of three hand-kept copies of the open gate, serve principal, serve epoch, and registration proof checks. The order and codes are unchanged. An enrollment refused for an absent or frozen gate now reads `enrollment found no current open manager gate for instance <id>`.
