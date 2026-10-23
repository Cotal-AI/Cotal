---
"@cotal-ai/delivery": patch
---

`cotal feedback-intake` now reads `--max-bytes` and `--rate-limit` with the shared positive-integer flag parser instead of its own copy. A value past the safe integer range, such as `1e300` or `9007199254740993`, used to be accepted, so the body cap or the per-tester rate limit could never trip. It is now refused before the intake dials the broker, and every refusal of these two flags names the rejected value.
