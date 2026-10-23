---
"@cotal-ai/cli": patch
---

`cotal send -c <channel> --mention <agent>` now puts the agent's name in the message's mention list, as SPEC §5 defines it. It used to put the agent's instance id there, so a `chat` session, which compares the list with its own label, received the post with `mentionsMe: false`, and the durable mention copy on a `live` channel never resolved. An instance id is still accepted and is sent as that agent's name, and it is refused when the name also resolves to another participant.
