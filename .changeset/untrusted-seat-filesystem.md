---
"@cotal-ai/bubblewrap": minor
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
---

Run untrusted Linux seats in an explicit Bubblewrap runtime without exposing the operator's files.

The runtime uses a credential-free root filesystem and the existing delegated user-auth lifecycle handoff. Trusted same-user runtimes remain available. Unsupported local launch paths fail rather than falling back to same-user execution.
