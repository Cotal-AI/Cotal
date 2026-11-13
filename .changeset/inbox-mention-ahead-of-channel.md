---
"@cotal-ai/connector-core": patch
---

A clearing `cotal_inbox` read now shows a current mention of you ahead of older channel posts. When older posts filled the receivable window, the read that followed a mention's wake returned those posts and held the mention back, with nothing in the reply saying so. Direct messages still come first. When they hold a mention back, the held note now counts it, for example `3 more messages held (2 direct, 1 mentioning you)`.
