---
"@cotal-ai/core": patch
---

`registerServiceInstance` distinguishes a reopen that lost its compare-and-set from one whose outcome is unknown. Both its Phase-4 and abort refusals tell the caller to re-read the gate rather than asserting it stayed frozen when the write may have committed. Both remain `unavailable`, and the abort refusal retains its original cause.
