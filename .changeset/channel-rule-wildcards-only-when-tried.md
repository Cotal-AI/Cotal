---
"@cotal-ai/core": patch
---

A channel name refused for a segment outside the token rule now names `'*'` and `'>'` only when that segment holds one. `gen eral` or `kanäle` is told the segment must be a NATS-safe token (`[A-Za-z0-9_-]`), and a segment such as `team.gen*` that holds one is still told it must be a NATS-safe token, `'*'` or `'>'`. Before, every refused segment was offered the wildcards, so `cotal send -c 'gen eral'` read as if `*` were a valid channel to post to. The same sentence reaches every surface that checks a channel name: `cotal send`, `cotal chat`, `cotal channel`, `cotal persona create` and manifests.
