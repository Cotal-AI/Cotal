---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal doctor auth --fix` mints a delivery or membership-rw credential the NATS client cannot parse again under a new identity when no broker answers, and says so in its result row. Every row that is not a plain re-sign has a `reason`. A refusal because the manager holds the renewal lease names `cotal down`, then `cotal doctor auth --fix`, and `cotal up` warns when it starts with such a membership-rw credential. A missing `membership-observer` or `connection-evictor` credential is a finding, with `cotal down` then `cotal up --rotate-sys` as its repair.
