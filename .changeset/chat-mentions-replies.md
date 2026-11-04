---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

A `cotal chat` post on a channel, in the terminal view and in `--plain`, now carries the `@names` its text holds as mentions, as `cotal send -c` and the console do, so it wakes the agents it names. The shared chat reply rule, `replyRecipient`, takes the session's principal and answers a channel message on its channel with `replyTo`; replying to your own DM or role task refuses. `AdmittedChatSession.send` takes an optional `replyTo`. A send, join or channel mode outside a session's grant now always names the step that opens a session on that channel, and so does the warning when you choose such a channel as the recipient.
