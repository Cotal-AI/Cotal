---
"@cotal-ai/cli": patch
---

The `AUTH_REQUIRED` refusal for a missing or rejected sign-in now says what the refused command left undone. A `team boot`, which refuses before any write, says nothing was started or written, and a `manager restart` over a running manager says the running manager was left running. Both used to say the manager was not attempted, which bare `up`, `manager start` and a `manager restart` with no manager running still say.
