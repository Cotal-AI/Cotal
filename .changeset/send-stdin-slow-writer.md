---
"@cotal-ai/cli": patch
---

`cotal send --stdin` now waits for a piped writer that has not written yet or pauses, instead of refusing with `the message on stdin could not be read`.
