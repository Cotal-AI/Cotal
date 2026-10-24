---
"@cotal-ai/cli": patch
---

`cotal chat` slash commands that take a channel (`/join`, `/leave`, `/info`, `/quiet`, `/mute`, `/normal`) read it with or without its `#`. A `#` no longer doubles in their answers, and a refused `/join` suggests `cotal chat <channel>` without a `#` a shell would read as a comment.
