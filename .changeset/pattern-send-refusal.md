---
"@cotal-ai/connector-core": patch
"@cotal-ai/pi": patch
---

`cotal_send` refuses a channel pattern such as `team.>` before it reads or sends anything. The refusal and the advertised `channel` text say how to reach those agents: one post to a channel the pattern matches reaches the followers connected at the time, or post to each channel by name. A name that breaks the channel grammar, such as `team.**`, is refused too. It used to be rewritten onto another channel while the receipt named what was typed. In pi, `cotal_send` now gives the same refusal as every other connector.
