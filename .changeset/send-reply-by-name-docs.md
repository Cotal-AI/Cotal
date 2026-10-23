---
"@cotal-ai/cli": patch
---

The `cotal send` guide now says when a recipient can answer by the sender's name. On a static or open mesh every send has its own principal under the same display name, so once a recipient has heard two sends from the same login and host, a reply by that name refuses with `TARGET_AMBIGUOUS`. The guide names the replies that still work: the id on the message, or `/reply` in `chat`. It used to say a reply by the sender's name always works.
