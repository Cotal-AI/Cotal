---
"@cotal-ai/cli": patch
---

`cotal join` refusals are classified. An unknown space, a rejected credential, a missing creds file, an unreachable broker, an unprovisioned lifecycle and the flag misuses each print their code on stderr and exit by the outcome table: 1 for a usage refusal, 2 for any other. Before, every one was a plain line with exit 1. `join` still has no `--json`, as `chat` has none.
