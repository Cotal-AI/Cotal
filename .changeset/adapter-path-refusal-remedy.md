---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A declared adapter path that other local writers could change is refused with every unsafe entry
at once, the reason group write is not accepted, and the one `chmod` that fixes them. Before, the
refusal named only the shallowest directory, with no reason and a Next that pointed at
`cotal service`. An install made by `npm i -g` under umask 0002 left the bundled `nats-server` and
each of its directories group-writable, so a controller `up` refused one directory per attempt.
