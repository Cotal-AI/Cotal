---
"@cotal-ai/lang": patch
---

The run-time half of L2032 now gives the reason that fits the scope a write is refused in. A write from a `once` or `conclave` body, or from a `waitUntil` probe, to a binding declared or a value built outside it now says that a settled scope is replayed without entering its body, and that the value should be read out of the scope's result. That is what the static check already says for `once` and `conclave`. Before, the refusal described concurrent branches writing in completion order and suggested `race`, which only applies to `parallel`, `race` and `fanOut`. The walker and the compiled engine now share one write check and refuse the same binding write with the same message, so a program that catches L2032 reads the same text on both engines. The compiled engine used to word a binding write as a value write.
