---
"@cotal-ai/connector-core": patch
---

`cotal_send` refuses a channel pattern such as `team.>` before it reads or sends anything. The refusal and the advertised `channel` text say how to reach those agents: post once to one channel the pattern matches, or post to each channel by name.
