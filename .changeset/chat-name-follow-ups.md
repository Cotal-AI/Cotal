---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
---

An @mention at the end of a sentence, such as `thanks @ops-lead.`, now reaches the person it names. `mentionsIn` ends each name on a letter, digit or `_`, because a chat name cannot end in `.` or `-`, so `cotal send`, `cotal chat`, the console and the dashboard no longer store the mention as `ops-lead.`. When a chat session's default name breaks the chat name rule, such as an OS login of `John Doe`, the refusal prints on its own and names `--name` and `cotal config set name`, and for a handle an older cotal recorded, signing in again. `cotal login` prints the chat name it recorded, or `none` with how to save one.
