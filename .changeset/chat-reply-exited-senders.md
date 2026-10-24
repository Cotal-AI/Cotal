---
"@cotal-ai/cli": patch
---

A `chat` reply by a name that only senders no longer present carry, such as several one-shot `cotal send` commands from one login and host, now says they are no longer present and names how to answer one message: `/reply`, or over `--stdio` a `dm` to the message's `from.id` with `replyTo` set to its id.
