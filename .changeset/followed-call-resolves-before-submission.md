---
"@cotal-ai/core": patch
---

A followed `invokeService` call (a `spawn` or `launch` that follows its goal, such as `cotal_spawn`) now resolves the endpoint before the submission starts. A describe the broker refused or nobody answered used to be reported as a submission whose outcome was unknown and that "may have been accepted or executed", although nothing had been published. It now surfaces as its own error, and an unanswered describe keeps its `ai.cotal.ep.unanswered` marker. A `failed-precondition` from the resolve is still retried once. A describe or command publish that the broker refuses now carries `outcome: "not-executed"`, so a followed call whose command the broker refuses, such as a spawn from a credential without the `spawn` capability, also no longer says it may have run.
