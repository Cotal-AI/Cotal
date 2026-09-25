---
"@cotal-ai/connector-jcode": patch
---

Give a Jcode seat launched with no spawn `--prompt` a scheduled turn after join: the post-join notice is now delivered as the seat's first driven turn instead of a no-reply append, so a persona subscribed to nothing is never parked on an unread append.
