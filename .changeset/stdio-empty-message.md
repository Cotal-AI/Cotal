---
"@cotal-ai/cli": patch
---

A `cotal chat --stdio` `send`, `dm` or `anycast` request whose `text` is empty or only whitespace is now refused with `USAGE_INVALID` and `the message is empty`, the sentence `cotal send` gives for an empty message. Before, the request was stored and showed in history as a row with no body.
