---
"@cotal-ai/manager": patch
---

`Manager.startAgent` refuses a `supervise` policy whose `restarts` or `windowMs` is not a positive integer before anything launches, with the same refusal the `spawn` command gives. Before, an in-process caller's bad policy was admitted, the seat launched and joined, and it was then torn down when its seat record refused the policy.
