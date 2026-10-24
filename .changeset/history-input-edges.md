---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`cotal history` accepts `#general` as a channel name, refuses a wildcard with the sentence `cotal send -c` gives, and warns `CHANNEL_NOT_FOUND` with no replay policy for a channel that has no messages and no saved entry. A flag value that starts with a dash and a digit, such as `--limit -1`, is read as that flag's value, so the command's own check answers it rather than the parser calling it ambiguous. `--since` takes an ISO 8601 date and time, and no longer reads forms such as `-5` as dates. `channelReplayPolicy` also returns whether the channel has its own registry entry.
