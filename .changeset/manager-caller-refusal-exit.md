---
"@cotal-ai/workspace": patch
---

On a user-auth mesh with more than one live manager, an unpinned `cotal models`, `cotal run ps` or other manager call is now reported as refused, exit 2, naming each live manager and `--on`. Before, the same refusal from the auth service was reported as "Outcome unconfirmed" with `OPERATION_UNKNOWN` and exit 3, although nothing had been requested.
