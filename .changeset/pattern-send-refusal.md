---
"@cotal-ai/connector-core": patch
---

`cotal_send` refuses a channel pattern such as `team.>` before it reads or sends anything. The refusal and the advertised `channel` text say how to reach those agents: one post to a channel the pattern matches reaches the followers connected at the time, or post to each channel by name.
