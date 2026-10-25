---
"@cotal-ai/cli": patch
---

A `down stack-broker` refused while a service outside the stack runs, such as one added with
`cotal service add`, now names that service's `cotal service stop` first and then bare `cotal down`,
which refuses beside it. Its other route names the stack members' own stops and the broker stop
again. The dry run warns with the same refusal.
