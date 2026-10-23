---
"@cotal-ai/cli": patch
---

`cotal send` and `cotal chat <channel>` now give the real reason when a channel or role name breaks the subject rules. `send --channel kanäle` or `--channel 'gen eral'` says the segment must be a NATS-safe token, and `send --role 'bad role!'` says the role must be a single NATS-safe token. Before, every invalid channel name got "name one concrete channel, without wildcards" and every invalid role got "name one native role token". A wildcard channel still gets the wildcard message.
