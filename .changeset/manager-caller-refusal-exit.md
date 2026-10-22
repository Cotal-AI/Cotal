---
"@cotal-ai/workspace": patch
---

On a user-auth mesh with more than one live manager, an unpinned `cotal models`, `cotal run ps` or other manager call is now reported as refused, exit 2, naming each live manager and `--on`. Before, the same refusal from the auth service was reported as "Outcome unconfirmed" with `OPERATION_UNKNOWN` and exit 3, although nothing had been requested. A manager-caller exchange that does not answer is likewise refused with `DEPENDENCY_UNAVAILABLE`, exit 2. `cotal attach` still retries a failed manager-caller exchange on a reconnect, and now stops when the exchange reports the operator signed out.
