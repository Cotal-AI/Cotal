---
"@cotal-ai/cli": patch
---

`cotal send -c <channel> --reply-to <message-id>` stores the channel post with `replyTo`, as a direct send already does. A role send still refuses `--reply-to`.
