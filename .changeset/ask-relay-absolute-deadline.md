---
"@cotal-ai/runtime": patch
"@cotal-ai/manager": patch
---

An `ask` attempt and an escalated `checkpoint` now relay the instant their pause denies at, and the manager holds the relay to that instant. The relay used to send a duration the manager counted from its own acceptance, so the seat could still be shown an attempt after its pause had expired, by the submit's round trip plus clock skew, or by up to a second from a one-second floor. The manager's `turn` command takes `deadlineAt` as an alternative to `deadlineMs` and refuses a relay whose deadline has already passed with `deadline-exceeded`. The run reads that refusal as nobody left to tell only when its own clock also shows the deadline passed. An `ask` whose deadline passes before its attempt's pause is minted now ends with its own `ask-deadline` L4006 instead of an L4000 from the refused mint.
